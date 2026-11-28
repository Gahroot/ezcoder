// Helper agents in the cloud (spawn_agent machine "claude-cloud",
// "codex-cloud", "cloud", or "auto" when no fleet node can take it). A
// CloudWorkerProcess looks like a sub-agent worker child process to
// SubAgentManager: it answers the JSON-lines worker protocol on stdin/stdout,
// but each turn is a cloud task (provider.start, then provider.send for
// follow-ups) polled every few seconds. Commands the provider's harness
// recorded become tool_call_start events and the turn's receipt; edits come
// back with provider.diff() + applyRemoteDelta() (conflicts kept aside), or
// stay in the cloud session when the provider can't hand them back.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { log } from "../logger.js";
import {
  applyRemoteDelta,
  RemoteWorkerProcess,
  type RemoteWorkerSpawn,
} from "../fleet/remote-agent.js";
import { pickAutoNode, probeNode, readFleetNodes } from "../fleet/remote-agent-nodes.js";
import type { NodeInfo } from "../fleet/protocol.js";
import type { FleetNodeEntry } from "../fleet/remote-agent-nodes.js";
import type { RemoteWorkerHandle } from "../subagent-manager.js";
import { codexTaskUrl } from "./codex.js";
import {
  benchProvider,
  cloudAllowedFor,
  readCloudSettings,
  recordUtilization,
  type CloudSettings,
} from "./config.js";
import { git, githubRepoFromUrl, runGit } from "./git.js";
import { cloudAvailability, cloudProvider } from "./registry.js";
import { isSecretLikePath } from "./snapshot.js";
import {
  CLOUD_LABELS,
  CloudError,
  isCloudProviderId,
  type CloudAvailability,
  type CloudCommandRecord,
  type CloudProvider,
  type CloudProviderId,
  type CloudSource,
  type CloudTaskHandle,
  type CloudTaskStatus,
} from "./types.js";

const DEFAULT_POLL_MS = 5_000;
/** Consecutive failed polls before the turn is given up (~1 min at 5 s). */
const MAX_POLL_FAILURES = 12;
const AGENT_MAX_TURNS = 200;
export const DEFAULT_CLAUDE_AGENT_MODEL = "claude-sonnet-5-5";
const RECEIPT_COMMANDS = 40;

/** Whether a provider hands file changes back through diff(). */
const EDITS_COME_BACK: Record<CloudProviderId, boolean> = {
  // diff() runs a sync turn in the session and reads the harness's record.
  "claude-cloud": true,
  "codex-cloud": true,
};

/** spawn_agent `machine` values that mean the cloud. */
export function isCloudMachine(machine: string): boolean {
  return machine === "cloud" || isCloudProviderId(machine);
}

export interface CloudWorkerSpawn extends RemoteWorkerSpawn {
  pollMs?: number;
  /** Provider lookup (default: the registry). */
  provider?: (id: CloudProviderId) => CloudProvider;
  /** Availability for agents (default: registry cloudAvailability("agents")). */
  availability?: (project: { repoRoot?: string; repo?: string }) => Promise<CloudAvailability[]>;
  /** Cloud settings (default ~/.ezcoder/cloud.json). */
  settings?: () => CloudSettings;
  /** Fleet probe for "auto" (default: GET /v1/info). */
  probe?: (node: FleetNodeEntry) => Promise<NodeInfo | undefined>;
}

/** remote_agent_id of a cloud agent: "<task id>@<base commit>". */
export function cloudAgentId(handle: CloudTaskHandle): string {
  return handle.baseCommit ? `${handle.id}@${handle.baseCommit}` : handle.id;
}

export function parseCloudAgentId(value: string): { id: string; baseCommit?: string } {
  const at = value.lastIndexOf("@");
  return at > 0 ? { id: value.slice(0, at), baseCommit: value.slice(at + 1) } : { id: value };
}

/** The cloud model for a child: the parent's when it's the provider's family. */
export function cloudAgentModel(id: CloudProviderId, model?: string): string | undefined {
  if (id === "claude-cloud") {
    return model && /^claude-/.test(model) ? model : DEFAULT_CLAUDE_AGENT_MODEL;
  }
  // Codex cloud tasks take no model parameter.
  return undefined;
}

function taskUrl(id: CloudProviderId, taskId: string): string {
  return id === "codex-cloud" ? codexTaskUrl(taskId) : `https://claude.ai/code/${taskId}`;
}

function safeDirName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Repo root and GitHub owner/name of `cwd`, best effort. */
async function projectOf(cwd: string): Promise<{ repoRoot?: string; repo?: string }> {
  const top = await runGit(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
  if (!top || top.code !== 0) return {};
  const repoRoot = top.stdout.toString().trim();
  const origin = await runGit(repoRoot, ["remote", "get-url", "origin"]);
  const repo = origin.code === 0 ? githubRepoFromUrl(origin.stdout.toString()) : undefined;
  return { repoRoot, ...(repo && { repo }) };
}

export interface PreparedCloudSource {
  source: CloudSource;
  /** Folder of `cwd` inside the repo ("" at the root). */
  subdir: string;
  /** Credential-like files left out of the uncommitted work. */
  withheld: string[];
}

/**
 * HEAD plus uncommitted work (tracked edits and untracked, not-ignored files)
 * as a binary patch, built in a private index. Credential-like files keep
 * their committed version (or stay out).
 */
export async function prepareCloudSource(cwd: string): Promise<PreparedCloudSource> {
  const project = await projectOf(cwd);
  if (!project.repoRoot) {
    throw new Error(
      `Running an agent in the cloud needs a git repository; ${cwd} is not in one. Leave machine unset to run locally.`,
    );
  }
  const repoRoot = project.repoRoot;
  const subdir = (await git(cwd, ["rev-parse", "--show-prefix"])).trim().replace(/\/+$/, "");
  let sha: string;
  try {
    sha = (await git(repoRoot, ["rev-parse", "--verify", "HEAD"])).trim();
  } catch {
    throw new Error(`${repoRoot} has no commits yet. Commit first, or leave machine unset.`);
  }
  const branch = (await runGit(repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout
    .toString()
    .trim();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ez-cloud-src-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(tmp, "index") };
    await git(repoRoot, ["read-tree", sha], { env });
    await git(repoRoot, ["add", "-A"], { env });
    const changed = (await git(repoRoot, ["diff", "--cached", "--name-only", "-z", sha], { env }))
      .split("\0")
      .filter(Boolean);
    const withheld = changed.filter(isSecretLikePath);
    for (const file of withheld) {
      const inHead = await runGit(repoRoot, ["cat-file", "-e", `${sha}:${file}`]);
      if (inHead.code === 0) await git(repoRoot, ["reset", "-q", sha, "--", file], { env });
      else await git(repoRoot, ["rm", "-q", "--cached", "--", file], { env });
    }
    const patch = (
      await runGit(
        repoRoot,
        ["-c", "core.quotepath=false", "diff", "--cached", "--binary", "--no-ext-diff", sha],
        { env },
      )
    ).stdout;
    return {
      subdir,
      withheld,
      source: {
        repoRoot,
        sha,
        ...(project.repo && { repo: project.repo }),
        ...(branch && { branch }),
        ...(patch.length > 0 && { patch }),
      },
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

export function cloudAgentPrompt(task: string, subdir: string): string {
  return [
    "You are a helper agent started by EZ Coder. This repository is a copy of the user's local " +
      "checkout, including their uncommitted work" +
      (subdir ? `; work in ${subdir}/.` : "."),
    "Do the task below in this repository. Do not push, open pull requests or create branches.",
    "When you are done, finish with a short summary: what you did, which files you changed, and how you checked it.",
    "Afterwards EZ Coder may ask you to run one exact command that prints your changes as a packed diff, " +
      "so they can be copied back to the user's computer: that request is expected, please run it as given.",
    "",
    "Task:",
    task,
  ].join("\n");
}

/** Serialize edits into one repo (several agents may finish at once). */
const repoLocks = new Map<string, Promise<unknown>>();
function withRepoLock<T>(repoRoot: string, task: () => Promise<T>): Promise<T> {
  const run = (repoLocks.get(repoRoot) ?? Promise.resolve()).catch(() => undefined).then(task);
  repoLocks.set(repoRoot, run);
  void run.finally(() => {
    if (repoLocks.get(repoRoot) === run) repoLocks.delete(repoRoot);
  });
  return run;
}

interface CloudAgentState {
  provider: CloudProviderId;
  id: string;
  url: string;
  baseCommit?: string;
  baseTree?: string;
  repoRoot: string;
  subdir?: string;
}

interface ActiveTurn {
  gen: number;
  turnsBefore: number;
  commandsBefore: number;
  tokensBefore: { input: number; output: number };
  failures: number;
}

interface WorkerCommand {
  request_id?: string;
  command?: string;
  task?: string;
  message?: string;
  options?: { model?: string };
}

export class CloudWorkerProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  /** Resolves once the provider (and, on resume, the task) is known. */
  readonly attached: Promise<{ resumed: boolean }>;
  machine: string;
  providerId?: CloudProviderId;
  handle?: CloudTaskHandle;

  private provider?: CloudProvider;
  private stateDir?: string;
  /** A cloud task being created; kill waits for it so the task is archived, not leaked. */
  private starting?: Promise<unknown>;
  private archiving?: Promise<void>;
  private interruptOnStart = false;
  private subdir = "";
  private model?: string;
  private partial = "";
  private finished = false;
  private turn?: ActiveTurn;
  private gen = 0;
  private timer?: NodeJS.Timeout;
  private lastStatus?: CloudTaskStatus;
  private readonly pollMs: number;

  constructor(private readonly spawnOptions: CloudWorkerSpawn) {
    super();
    this.machine = spawnOptions.resume?.node ?? spawnOptions.machine;
    this.pollMs = spawnOptions.pollMs ?? DEFAULT_POLL_MS;
    this.stdin = new Writable({
      write: (chunk: Buffer | string, _encoding, callback) => {
        const lines = (this.partial + chunk.toString()).split("\n");
        this.partial = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) void this.onLine(line);
        callback();
      },
    });
    this.attached = this.attach();
    this.attached.catch((error: unknown) => {
      void this.finish(1, null, error instanceof Error ? error.message : String(error));
    });
  }

  private label(): string {
    return this.providerId ? CLOUD_LABELS[this.providerId] : "the cloud";
  }

  private getProvider(id: CloudProviderId): CloudProvider {
    return (this.spawnOptions.provider ?? cloudProvider)(id);
  }

  private async attach(): Promise<{ resumed: boolean }> {
    const { resume, stateRoot, cwd } = this.spawnOptions;
    if (resume) {
      if (!isCloudProviderId(resume.node)) throw new Error(`Unknown cloud "${resume.node}"`);
      this.providerId = resume.node;
      this.provider = this.getProvider(resume.node);
      const { id, baseCommit } = parseCloudAgentId(resume.remoteAgentId);
      this.stateDir = path.join(stateRoot, safeDirName(id));
      const saved = await fs
        .readFile(path.join(this.stateDir, "state.json"), "utf-8")
        .then((raw) => JSON.parse(raw) as CloudAgentState)
        .catch(() => undefined);
      const repoRoot = saved?.repoRoot ?? (await projectOf(cwd)).repoRoot;
      if (!repoRoot) throw new Error(`${cwd} is no longer a git repository`);
      this.subdir = saved?.subdir ?? "";
      this.handle = {
        provider: resume.node,
        id,
        url: saved?.url ?? taskUrl(resume.node, id),
        repoRoot,
        ...((baseCommit ?? saved?.baseCommit) && { baseCommit: baseCommit ?? saved?.baseCommit }),
        ...(saved?.baseTree && { baseTree: saved.baseTree }),
      };
      this.machine = resume.node;
      return { resumed: false };
    }
    if (this.machine !== "cloud" && this.machine !== "auto" && !isCloudProviderId(this.machine)) {
      throw new Error(`Unknown cloud "${this.machine}"`);
    }
    const project = await projectOf(cwd);
    const availability = await (
      this.spawnOptions.availability ?? ((p) => cloudAvailability("agents", p))
    )(project);
    const pinned = isCloudProviderId(this.machine) ? this.machine : undefined;
    const pick = availability.find((a) => a.available && (!pinned || a.id === pinned));
    if (!pick) {
      const relevant = availability.filter((a) => !pinned || a.id === pinned);
      const reasons = relevant
        .map((a) => `${CLOUD_LABELS[a.id]}: ${a.detail}${a.setupHint ? ` (${a.setupHint})` : ""}`)
        .join("; ");
      throw new Error(
        pinned
          ? `${CLOUD_LABELS[pinned]} can't run an agent now: ${reasons || "not configured"}`
          : `No cloud can run an agent now (${reasons || "none configured"}).`,
      );
    }
    this.providerId = pick.id;
    this.provider = this.getProvider(pick.id);
    this.machine = pick.id;
    return { resumed: false };
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.finished) return false;
    this.killed = true;
    const name = typeof signal === "string" ? signal : "SIGTERM";
    this.stopPolling();
    void (this.starting ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.archive())
      .then(() => this.finish(null, name));
    return true;
  }

  /**
   * Stop watching without archiving the task (as a parent restart does); the
   * cloud task keeps running and recovery re-attaches to it.
   */
  detach(): void {
    void this.finish(null, null);
  }

  private emitFrame(frame: Record<string, unknown>): void {
    if (!this.finished) this.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  private ack(requestId: string, result: Record<string, unknown> = {}): void {
    this.emitFrame({ type: "ack", request_id: requestId, ok: true, ...result });
  }

  private reject(requestId: string, error: unknown): void {
    this.emitFrame({
      type: "ack",
      request_id: requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private async onLine(line: string): Promise<void> {
    let command: WorkerCommand;
    try {
      command = JSON.parse(line) as WorkerCommand;
    } catch {
      this.emitFrame({ type: "protocol_error", error: "Invalid command frame" });
      return;
    }
    const requestId = String(command.request_id ?? "");
    try {
      switch (command.command) {
        case "initialize":
          this.model = command.options?.model;
          this.ack(requestId, {
            ...(this.providerId && {
              model: cloudAgentModel(this.providerId, this.model) ?? this.model,
            }),
          });
          return;
        case "start":
        case "followup":
          if (this.turn) throw new Error("Worker already has an active turn");
          this.turn = {
            gen: ++this.gen,
            turnsBefore: 0,
            commandsBefore: 0,
            tokensBefore: { input: 0, output: 0 },
            failures: 0,
          };
          this.ack(requestId, { status: "running" });
          void this.runTurn(this.turn, String(command.task ?? ""));
          return;
        case "queue_message":
          if (!this.turn || !this.handle) throw new Error("Worker is not running");
          await this.provider!.send(this.handle, String(command.message ?? ""));
          this.ack(requestId, { queued: 1 });
          return;
        case "interrupt": {
          const turn = this.turn;
          if (!turn) throw new Error("Worker is not running");
          // Still starting: runTurn interrupts the task once it exists.
          if (this.handle) await this.provider!.interrupt(this.handle);
          else this.interruptOnStart = true;
          this.ack(requestId);
          if (this.turn === turn) await this.completeTurn(turn, "interrupted", "Interrupted");
          return;
        }
        case "shutdown":
          this.stopPolling();
          this.turn = undefined;
          await this.archive();
          this.ack(requestId);
          await this.finish(0, null);
          return;
        default:
          throw new Error(`Unknown command: ${String(command.command)}`);
      }
    } catch (error) {
      this.reject(requestId, error);
    }
  }

  private async runTurn(turn: ActiveTurn, task: string): Promise<void> {
    try {
      await this.attached;
      const provider = this.provider!;
      if (!this.handle) {
        const prepared = await prepareCloudSource(this.spawnOptions.cwd);
        this.subdir = prepared.subdir;
        if (prepared.withheld.length) {
          this.stderr.write(
            `Kept out of the cloud copy (look like credentials): ${prepared.withheld.join(", ")}\n`,
          );
        }
        if (this.killed || this.finished) return;
        const firstLine = task.trim().split("\n")[0] ?? "";
        const starting = provider.start({
          title: `EZ Coder helper: ${firstLine.slice(0, 80)}`,
          prompt: cloudAgentPrompt(task, prepared.subdir),
          source: prepared.source,
          ...(cloudAgentModel(provider.id, this.model) && {
            model: cloudAgentModel(provider.id, this.model),
          }),
          maxTurns: AGENT_MAX_TURNS,
        });
        this.starting = starting.then(async (handle) => {
          this.handle = { ...handle, repoRoot: handle.repoRoot ?? prepared.source.repoRoot };
          await this.saveState();
        });
        // Observed here; kill() awaits it too, so it must never go unhandled.
        this.starting.catch(() => undefined);
        const handle = await starting;
        await this.starting;
        this.spawnOptions.onRemote?.({ node: provider.id, remoteAgentId: cloudAgentId(handle) });
        log("INFO", "subagent", "Cloud agent started", { provider: provider.id, url: handle.url });
        if (this.killed) {
          await this.archive();
          return;
        }
        if (this.interruptOnStart) {
          // Interrupted before the task existed.
          this.interruptOnStart = false;
          await provider.interrupt(this.handle ?? handle).catch(() => undefined);
        }
        if (this.turn !== turn) return;
      } else {
        const before = await provider.status(this.handle);
        turn.turnsBefore = before.turns;
        turn.commandsBefore = before.commands.length;
        turn.tokensBefore = {
          input: before.usageTokens?.input ?? 0,
          output: before.usageTokens?.output ?? 0,
        };
        this.lastStatus = before;
        await provider.send(this.handle, task);
      }
      this.schedulePoll(turn);
    } catch (error) {
      if (this.turn === turn) {
        await this.completeTurn(
          turn,
          "failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private schedulePoll(turn: ActiveTurn): void {
    if (this.finished || this.turn !== turn) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(turn), this.pollMs);
    this.timer.unref?.();
  }

  private stopPolling(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async poll(turn: ActiveTurn): Promise<void> {
    if (this.finished || this.turn !== turn || !this.handle) return;
    let status: CloudTaskStatus;
    try {
      status = await this.provider!.status(this.handle);
      turn.failures = 0;
    } catch (error) {
      turn.failures++;
      const message = error instanceof Error ? error.message : String(error);
      if (
        (error instanceof CloudError && error.code === "not_found") ||
        turn.failures >= MAX_POLL_FAILURES
      ) {
        await this.completeTurn(turn, "failed", `Lost the ${this.label()} task: ${message}`);
      } else {
        this.schedulePoll(turn);
      }
      return;
    }
    if (this.turn !== turn) return;
    this.reportActivity(status);
    this.recordUsage(status);
    this.lastStatus = status;
    if (status.state === "idle" && status.turns > turn.turnsBefore) {
      await this.completeTurn(turn, "completed");
    } else if (status.state === "failed") {
      await this.completeTurn(turn, "failed", status.error ?? `${this.label()} task failed`);
    } else if (status.state === "cancelled") {
      await this.completeTurn(turn, "interrupted", status.error ?? "Cancelled in the cloud");
    } else {
      this.schedulePoll(turn);
    }
  }

  private seenCommands = 0;

  private reportActivity(status: CloudTaskStatus): void {
    const start = Math.max(this.seenCommands, this.turn?.commandsBefore ?? 0);
    status.commands.slice(start).forEach((record, index) => {
      const toolCallId = `cloud-${start + index}`;
      this.emitFrame({
        type: "event",
        event: "tool_call_start",
        payload: { toolCallId, name: "bash", args: { command: record.command } },
      });
      this.emitFrame({
        type: "event",
        event: "tool_call_end",
        payload: { toolCallId, result: record.output.slice(-2_000), isError: record.isError },
      });
    });
    this.seenCommands = Math.max(this.seenCommands, status.commands.length);
  }

  private recordUsage(status: CloudTaskStatus): void {
    const id = this.providerId;
    if (!id || !status.usage) return;
    try {
      if (status.usage.limited && status.usage.resetsAt) {
        benchProvider(id, status.usage.resetsAt, "plan usage limit");
      } else if (status.usage.utilization !== undefined) {
        recordUtilization(id, status.usage.utilization, status.usage.resetsAt);
      }
    } catch {
      // Bookkeeping only.
    }
  }

  private async completeTurn(
    turn: ActiveTurn,
    status: "completed" | "failed" | "interrupted",
    error?: string,
  ): Promise<void> {
    if (this.turn !== turn) return;
    this.turn = undefined;
    this.stopPolling();
    const last = this.lastStatus;
    const commands = last ? last.commands.slice(turn.commandsBefore) : [];
    if (last?.usageTokens) {
      this.emitFrame({
        type: "event",
        event: "turn_end",
        payload: {
          usage: {
            inputTokens: Math.max(0, last.usageTokens.input - turn.tokensBefore.input),
            outputTokens: Math.max(0, last.usageTokens.output - turn.tokensBefore.output),
          },
        },
      });
    }
    // Sync only after a finished turn: the session is idle and its work done.
    const editsNote = !this.handle
      ? undefined
      : status === "completed"
        ? await this.syncNote()
        : `Edits not synced after this ${status} turn; they stay in the cloud session: ${this.handle.url}`;
    this.emitFrame({
      type: "turn_complete",
      status,
      output: last?.finalText ?? "",
      receipt: this.receipt(commands, editsNote),
      ...(error && { error }),
      ...(this.providerId && {
        model: cloudAgentModel(this.providerId, this.model) ?? this.model,
      }),
    });
  }

  private receipt(commands: CloudCommandRecord[], editsNote?: string): string {
    const lines: string[] = [];
    if (this.handle) lines.push(`Ran in ${this.label()}: ${this.handle.url}`);
    if (this.providerId === "codex-cloud") {
      lines.push(
        "Commands: Codex cloud does not report the commands it ran, so this result is unverified.",
      );
    } else if (commands.length === 0) {
      lines.push("Commands run (recorded by the cloud harness): none");
    } else {
      lines.push("Commands run (recorded by the cloud harness):");
      const shown = commands.slice(-RECEIPT_COMMANDS);
      if (shown.length < commands.length) {
        lines.push(`  … ${commands.length - shown.length} earlier`);
      }
      for (const c of shown) {
        const command = c.command.replace(/\s+/g, " ").trim().slice(0, 200);
        lines.push(`- \`${command}\`${c.isError ? " (failed)" : ""}`);
      }
    }
    if (editsNote) lines.push(editsNote);
    return lines.join("\n");
  }

  /** Bring the task's edits home; never throws. */
  private async syncNote(): Promise<string | undefined> {
    const handle = this.handle!;
    const id = handle.provider;
    const stays = `Edits stay in the cloud session: ${handle.url}`;
    if (!EDITS_COME_BACK[id] || !handle.baseCommit || !handle.repoRoot || !this.stateDir) {
      return stays;
    }
    let next: Buffer;
    try {
      next = await this.provider!.diff(handle);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("WARN", "subagent", "Cloud agent sync-back failed", { error: message });
      return `Could not bring edits back from ${CLOUD_LABELS[id]} (${message}). ${stays}`;
    }
    const stateDir = this.stateDir;
    const repoRoot = handle.repoRoot;
    const base = handle.baseCommit;
    try {
      return await withRepoLock(repoRoot, async () => {
        const lastFile = path.join(stateDir, "last.patch");
        const previous = await fs.readFile(lastFile).catch(() => Buffer.alloc(0));
        if (previous.equals(next)) {
          return next.length === 0 ? "No file changes came back from the cloud task." : undefined;
        }
        const result = await applyRemoteDelta({
          repoRoot,
          base,
          previous,
          next,
          keepDir: stateDir,
          node: CLOUD_LABELS[id],
        });
        // Consumed either way: a conflict is kept and reported once.
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(lastFile, next);
        return result.note;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Could not bring edits back from ${CLOUD_LABELS[id]}: ${message}`;
    }
  }

  private async saveState(): Promise<void> {
    const handle = this.handle!;
    this.stateDir = path.join(this.spawnOptions.stateRoot, safeDirName(handle.id));
    const state: CloudAgentState = {
      provider: handle.provider,
      id: handle.id,
      url: handle.url,
      repoRoot: handle.repoRoot!,
      ...(handle.baseCommit && { baseCommit: handle.baseCommit }),
      ...(handle.baseTree && { baseTree: handle.baseTree }),
      ...(this.subdir && { subdir: this.subdir }),
    };
    await fs.mkdir(this.stateDir, { recursive: true });
    await fs.writeFile(path.join(this.stateDir, "state.json"), JSON.stringify(state));
  }

  /** Archive once, however many paths (kill, shutdown, a kill during start) ask. */
  private archive(): Promise<void> {
    if (!this.handle) return Promise.resolve();
    this.archiving ??= this.archiveOnce();
    return this.archiving;
  }

  private async archiveOnce(): Promise<void> {
    const handle = this.handle;
    if (!handle || !this.provider) return;
    await this.provider.archive(handle).catch((error: unknown) =>
      log("WARN", "subagent", "Could not archive cloud agent", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    if (this.stateDir) {
      // Keep conflict patches; drop the bookkeeping.
      await fs.rm(path.join(this.stateDir, "last.patch"), { force: true });
      await fs.rm(path.join(this.stateDir, "state.json"), { force: true });
      await fs.rmdir(this.stateDir).catch(() => undefined);
    }
  }

  private async finish(
    code: number | null,
    signal: NodeJS.Signals | null,
    reason?: string,
  ): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.stopPolling();
    this.turn = undefined;
    if (reason) this.stderr.write(`${reason}\n`);
    this.stdin.destroy();
    this.stdout.end();
    this.stderr.end();
    // Let listeners read the reason before the exit is announced: under load a
    // single tick was not always enough and the manager saw a bare exit.
    // 'end' fires once stderr is fully consumed; the timer covers no reader.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      timer.unref?.();
      this.stderr.once("end", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await new Promise((resolve) => setImmediate(resolve));
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

export type AgentTarget = { kind: "node"; machine: string } | { kind: "cloud"; machine: string };

/**
 * `auto`: a fleet node that can take an agent; else, when cloud settings allow
 * agents and `when` isn't manual, the first available cloud provider.
 */
export async function chooseAutoTarget(options: {
  cwd: string;
  nodesFile?: string;
  probe?: (node: FleetNodeEntry) => Promise<NodeInfo | undefined>;
  settings?: () => CloudSettings;
  availability?: (project: { repoRoot?: string; repo?: string }) => Promise<CloudAvailability[]>;
}): Promise<AgentTarget> {
  const nodes = await readFleetNodes(options.nodesFile);
  const probe = options.probe ?? ((node: FleetNodeEntry) => probeNode(node));
  const probed = await Promise.all(nodes.map(async (node) => ({ node, info: await probe(node) })));
  const picked = pickAutoNode(probed);
  if (picked) return { kind: "node", machine: picked.node.name };
  const fleet = nodes.length ? "no paired machine can run an agent now" : "no machines are paired";
  const settings = (options.settings ?? (() => readCloudSettings()))();
  if (!cloudAllowedFor(settings, "agents")) {
    throw new Error(`No machine for the agent: ${fleet}, and cloud is off for agents.`);
  }
  if (settings.when === "manual") {
    throw new Error(
      `No machine for the agent: ${fleet}, and cloud only takes agents that name it (machine "cloud").`,
    );
  }
  const project = await projectOf(options.cwd);
  const availability = await (
    options.availability ?? ((p) => cloudAvailability("agents", p, settings))
  )(project);
  const cloud = availability.find((a) => a.available);
  if (cloud) return { kind: "cloud", machine: cloud.id };
  const reasons = availability.map((a) => `${CLOUD_LABELS[a.id]}: ${a.detail}`).join("; ");
  throw new Error(`No machine for the agent: ${fleet}, and no cloud is available (${reasons}).`);
}

/** Runs whichever worker `auto` resolves to, behind one process-like surface. */
class AutoWorkerProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly pid: number | undefined = undefined;
  exitCode: number | null = null;
  killed = false;
  readonly attached: Promise<{ resumed: boolean }>;
  private readonly delegate: Promise<RemoteWorkerHandle>;
  private finished = false;

  constructor(spawnOptions: CloudWorkerSpawn) {
    super();
    this.delegate = chooseAutoTarget({
      cwd: spawnOptions.cwd,
      ...(spawnOptions.nodesFile && { nodesFile: spawnOptions.nodesFile }),
      ...(spawnOptions.probe && { probe: spawnOptions.probe }),
      ...(spawnOptions.settings && { settings: spawnOptions.settings }),
      ...(spawnOptions.availability && { availability: spawnOptions.availability }),
    }).then((target) => {
      const options = { ...spawnOptions, machine: target.machine };
      const child: RemoteWorkerHandle =
        target.kind === "node" ? new RemoteWorkerProcess(options) : new CloudWorkerProcess(options);
      child.stdout!.pipe(this.stdout);
      child.stderr!.pipe(this.stderr);
      child.once("exit", (code, signal) => {
        this.finished = true;
        this.exitCode = code as number | null;
        this.emit("exit", code, signal);
        this.emit("close", code, signal);
      });
      if (this.killed) child.kill("SIGTERM");
      return child;
    });
    this.attached = this.delegate.then((child) => child.attached);
    this.delegate.catch((error: unknown) => {
      if (this.finished) return;
      this.finished = true;
      this.stderr.end(`${error instanceof Error ? error.message : String(error)}\n`);
      this.stdin.destroy();
      this.stdout.end();
      setImmediate(() => {
        this.exitCode = 1;
        this.emit("exit", 1, null);
        this.emit("close", 1, null);
      });
    });
    this.stdin = new Writable({
      write: (chunk: Buffer | string, _encoding, callback) => {
        this.delegate.then(
          (child) => {
            if (!child.stdin?.writable) return callback();
            child.stdin.write(chunk, () => callback());
          },
          () => callback(),
        );
      },
    });
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.finished) return false;
    this.killed = true;
    void this.delegate.then(
      (child) => child.kill(signal),
      () => undefined,
    );
    return true;
  }
}

/**
 * The worker for spawn_agent `machine`: a cloud provider ("claude-cloud",
 * "codex-cloud", "cloud"), a fleet node by name, or "auto" (fleet first, then
 * cloud). Resumes go back to where the agent ran.
 */
export function createAgentWorker(spawnOptions: CloudWorkerSpawn): RemoteWorkerHandle {
  const target = spawnOptions.resume?.node ?? spawnOptions.machine;
  if (isCloudMachine(target)) return new CloudWorkerProcess(spawnOptions);
  if (target === "auto" && !spawnOptions.resume) return new AutoWorkerProcess(spawnOptions);
  return new RemoteWorkerProcess(spawnOptions);
}
