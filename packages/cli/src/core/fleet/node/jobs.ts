// Jobs on a fleet node: one command per job in its own workspace, run by a
// detached shell wrapper (exit file, pid, timeout) so it keeps going — and its
// result is still collected — if the node restarts meanwhile. Host shell or
// Docker (image / Dockerfile / compose). Artifacts are copied out by glob when
// the job ends, then the workspace is removed.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type {
  ArtifactInfo,
  JobKind,
  JobRequest,
  JobStatus,
  NodeJobState,
  SourceSpec,
} from "../protocol.js";
import type { NodeConfig } from "./context.js";
import { readSecrets } from "./config.js";
import {
  containerCacheEnv,
  containerName,
  envFlags,
  FLEET_LABEL,
  hostCacheEnv,
  isValidEnvName,
  resourceArgs,
  validateDockerArgs,
  validateDockerSpec,
} from "./docker.js";
import { isSafeId, pidAlive, shQuote, type NodeExec } from "./exec.js";
import type { JobRecord, StateStore } from "./state.js";
import {
  cacheDir,
  cleanupWorkspace,
  isRealPathInside,
  prepareWorkspaceDetailed,
  resolveInside,
  sanitizeCacheKey,
  workspaceRoot,
  type PreparedWorkspace,
} from "./workspace.js";

const WRAPPER = `
set -m
cd "$EZF_CWD" || { echo 127 > "$EZF_DIR/exit"; exit; }
( eval "$EZF_CMD" ) >> "$EZF_DIR/output.log" 2>&1 < /dev/null &
p=$!
echo $p > "$EZF_DIR/pid"
( sleep "$EZF_TIMEOUT"; echo timeout > "$EZF_DIR/timeout"; kill -TERM -- -$p 2>/dev/null; sleep "$EZF_GRACE"; kill -KILL -- -$p 2>/dev/null ) &
w=$!
wait $p; c=$?
kill -- -$w 2>/dev/null || kill $w 2>/dev/null
echo $c > "$EZF_DIR/exit.tmp" && mv "$EZF_DIR/exit.tmp" "$EZF_DIR/exit"
`;

const JOB_KINDS: ReadonlySet<JobKind> = new Set([
  "validate",
  "build",
  "test",
  "browser",
  "render",
  "deploy",
  "custom",
]);
const TERMINAL: ReadonlySet<NodeJobState> = new Set([
  "passed",
  "failed",
  "error",
  "cancelled",
  "lost",
]);
const KEEP_DAYS = 14;
const MAX_ARTIFACT_FILES = 5000;
const MAX_ARTIFACT_BYTES = 10 * 1024 ** 3;
const MAX_LOG_CHUNK = 8 * 1024 * 1024;

export function isTerminalJob(state: NodeJobState): boolean {
  return TERMINAL.has(state);
}

export interface SlotTable {
  /** `force` re-takes a slot for a re-adopted job even when over the limit. */
  acquire(owner: string, force?: boolean): boolean;
  release(owner: string): void;
}

export interface JobManagerOptions {
  config: NodeConfig;
  state: StateStore;
  exec: NodeExec;
  slots: SlotTable;
  log?: (msg: string) => void;
  dockerAvailable?: () => Promise<boolean>;
  prepare?: (kind: "job", id: string, source: SourceSpec | undefined) => Promise<PreparedWorkspace>;
  pollMs?: number;
  /** Seconds between TERM and KILL on cancel/timeout. */
  killGraceSeconds?: number;
  /** Timeout unit in seconds (tests shrink it). Default 60. */
  secondsPerMinute?: number;
}

export interface ApiResult {
  status: number;
  body: unknown;
}

const err = (status: number, error: string): ApiResult => ({ status, body: { error } });

export class JobManager {
  private readonly cfg: NodeConfig;
  private readonly state: StateStore;
  private readonly exec: NodeExec;
  private readonly slots: SlotTable;
  private readonly log: (msg: string) => void;
  private timer?: ReturnType<typeof setInterval>;
  private finalizing = new Set<string>();
  private readonly grace: number;

  constructor(private readonly opts: JobManagerOptions) {
    this.cfg = opts.config;
    this.state = opts.state;
    this.exec = opts.exec;
    this.slots = opts.slots;
    this.log = opts.log ?? (() => {});
    this.grace = opts.killGraceSeconds ?? 10;
  }

  // ── paths ──────────────────────────────────────────────────────────────
  runDir(id: string): string {
    return path.join(this.cfg.dataDir, "run", id);
  }
  artifactsDir(id: string): string {
    return path.join(this.cfg.dataDir, "artifacts", id);
  }
  private logFile(id: string): string {
    return path.join(this.runDir(id), "output.log");
  }

  private records(): JobRecord[] {
    return this.state.data.jobs;
  }
  private find(id: string): JobRecord | undefined {
    return this.records().find((r) => r.status.id === id);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────
  /** Re-adopt jobs from the previous node process, prune old ones, start polling. */
  async init(): Promise<void> {
    const rebooted = this.state.rebooted();
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
    for (const rec of [...this.records()]) {
      const s = rec.status;
      if (isTerminalJob(s.state)) {
        if (s.finishedAt && Date.parse(s.finishedAt) < cutoff) this.removeFiles(rec, true);
        continue;
      }
      if (s.state === "preparing") {
        await this.finalize(
          rec,
          "lost",
          undefined,
          "the node restarted while preparing the workspace",
        );
        continue;
      }
      if (fs.existsSync(path.join(this.runDir(s.id), "exit"))) {
        await this.collect(rec);
        continue;
      }
      if (!rebooted && pidAlive(rec.wrapperPid)) {
        this.slots.acquire(s.id, true);
        this.log(`job ${s.id}: re-adopted (pid ${rec.wrapperPid})`);
        continue;
      }
      if (rec.docker && (await this.containerRunning(s.id))) {
        this.slots.acquire(s.id, true);
        this.reattachContainer(rec);
        this.log(`job ${s.id}: re-adopted container ${containerName(s.id)}`);
        continue;
      }
      await this.finalize(
        rec,
        "lost",
        undefined,
        "the node restarted and the job could not be re-adopted",
      );
    }
    this.state.data.jobs = this.records().filter(
      (r) =>
        !(
          isTerminalJob(r.status.state) &&
          r.status.finishedAt &&
          Date.parse(r.status.finishedAt) < cutoff
        ),
    );
    this.state.save();
    this.timer = setInterval(() => void this.pollAll(), this.opts.pollMs ?? 1000);
    this.timer.unref();
  }

  /** Stop polling. Running jobs keep going (detached) and are re-adopted next start. */
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  list(): JobStatus[] {
    return this.records().map((r) => this.status(r));
  }

  get(id: string): JobStatus | undefined {
    const rec = this.find(id);
    return rec && this.status(rec);
  }

  running(): number {
    return this.records().filter((r) => !isTerminalJob(r.status.state)).length;
  }

  private status(rec: JobRecord): JobStatus {
    let logBytes = rec.status.logBytes;
    try {
      logBytes = fs.statSync(this.logFile(rec.status.id)).size;
    } catch {
      // no log yet / purged
    }
    return { ...rec.status, logBytes };
  }

  // ── submit ─────────────────────────────────────────────────────────────
  validate(req: JobRequest): string | undefined {
    if (!req || typeof req !== "object") return "body must be a JobRequest";
    if (!isSafeId(req.id)) return "invalid job id";
    if (!JOB_KINDS.has(req.kind)) return `invalid job kind: ${String(req.kind)}`;
    if (typeof req.project !== "string" || !req.project) return "project is required";
    if (typeof req.command !== "string" || !req.command.trim()) return "command is required";
    if (
      typeof req.timeoutMinutes !== "number" ||
      !(req.timeoutMinutes > 0) ||
      req.timeoutMinutes > 7 * 24 * 60
    ) {
      return "timeoutMinutes must be between 0 and 10080";
    }
    for (const [k, v] of Object.entries(req.env ?? {})) {
      if (!isValidEnvName(k) || typeof v !== "string") return `invalid env var: ${k}`;
    }
    for (const s of req.secrets ?? []) if (!isValidEnvName(s)) return `invalid secret name: ${s}`;
    for (const g of req.artifacts ?? []) {
      if (typeof g !== "string" || path.isAbsolute(g) || g.split(/[\\/]/).includes("..")) {
        return `invalid artifact glob: ${String(g)}`;
      }
    }
    if (req.docker) {
      const e = validateDockerSpec(req.docker, this.cfg.dataDir);
      if (e) return e;
    }
    if (req.source && (typeof req.source.git !== "string" || typeof req.source.sha !== "string")) {
      return "source needs git and sha";
    }
    return undefined;
  }

  async submit(req: JobRequest): Promise<ApiResult> {
    const existing = req && isSafeId(req.id) ? this.find(req.id) : undefined;
    if (existing) return { status: 200, body: this.status(existing) };
    const invalid = this.validate(req);
    if (invalid) return err(400, invalid);

    let secrets: Record<string, string> = {};
    if (req.secrets?.length) {
      if (!this.cfg.labels.includes("deploy")) {
        return err(403, "this node is not labelled 'deploy' and does not accept jobs with secrets");
      }
      const all = readSecrets(this.cfg.dataDir);
      const missing = req.secrets.filter((n) => !(n in all));
      if (missing.length) return err(400, `secret not set on this node: ${missing.join(", ")}`);
      secrets = Object.fromEntries(req.secrets.map((n) => [n, all[n]!]));
    }
    const needLabels = (req.resources?.labels ?? []).filter(
      (l) => !this.cfg.labels.includes(l) && l !== "gpu",
    );
    if (needLabels.length) return err(409, `node lacks labels: ${needLabels.join(", ")}`);
    if (req.docker && this.opts.dockerAvailable && !(await this.opts.dockerAvailable())) {
      return err(409, "docker is not available on this node");
    }
    if (!this.slots.acquire(req.id)) return err(429, "all slots are busy");

    const rec: JobRecord = {
      status: {
        id: req.id,
        kind: req.kind,
        project: req.project,
        state: "preparing",
        startedAt: new Date().toISOString(),
        logBytes: 0,
      },
      timeoutMinutes: req.timeoutMinutes,
      docker: req.docker,
      artifactGlobs: req.artifacts,
    };
    this.records().push(rec);
    this.state.save();
    fs.rmSync(this.runDir(req.id), { recursive: true, force: true });
    fs.rmSync(this.artifactsDir(req.id), { recursive: true, force: true });
    fs.mkdirSync(this.runDir(req.id), { recursive: true });
    void this.start(rec, req, secrets);
    return { status: 201, body: this.status(rec) };
  }

  private appendLog(id: string, line: string): void {
    try {
      fs.appendFileSync(this.logFile(id), line.endsWith("\n") ? line : line + "\n");
    } catch {
      // purged meanwhile
    }
  }

  private async start(
    rec: JobRecord,
    req: JobRequest,
    secrets: Record<string, string>,
  ): Promise<void> {
    const id = req.id;
    try {
      if (req.source)
        this.appendLog(id, `[ezcoder node] preparing ${req.source.git} @ ${req.source.sha}`);
      const ws = await (this.opts.prepare
        ? this.opts.prepare("job", id, req.source)
        : prepareWorkspaceDetailed({
            dataDir: this.cfg.dataDir,
            kind: "job",
            id,
            source: req.source,
            exec: this.exec,
          }));
      rec.root = ws.root;
      rec.cwd = ws.cwd;
      rec.subdir = ws.subdir;
      if (this.find(id) !== rec) {
        cleanupWorkspace(this.cfg.dataDir, "job", id); // purged while preparing
        return;
      }
      if (rec.cancelRequested) {
        await this.finalize(rec, "cancelled", undefined, "cancelled before start");
        return;
      }
      if (req.docker) {
        // Re-check host mounts now that the workspace (and any symlinks in it) exists.
        const argsErr = validateDockerArgs(req.docker.args, this.cfg.dataDir);
        if (argsErr) throw new Error(argsErr);
        for (const p of [req.docker.dockerfile, req.docker.compose]) {
          if (p && !isRealPathInside(ws.root, path.join(ws.cwd, p)))
            throw new Error(`docker paths must stay inside the workspace: ${p}`);
        }
      }
      this.launch(rec, req, secrets);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.appendLog(id, `[ezcoder node] ${msg}`);
      await this.finalize(rec, "error", undefined, msg.split("\n")[0]!.slice(0, 300));
    }
  }

  /** The shell command for the job (host or docker) and the env the wrapper needs. */
  buildCommand(
    req: Pick<
      JobRequest,
      "id" | "command" | "docker" | "env" | "resources" | "cacheKey" | "project"
    >,
    ws: PreparedWorkspace,
    secrets: Record<string, string> = {},
  ): { command: string; env: Record<string, string> } {
    const cache = cacheDir(this.cfg.dataDir, sanitizeCacheKey(req.cacheKey ?? req.project));
    const userEnv = { ...(req.env ?? {}), ...secrets };
    const d = req.docker;
    if (!d) return { command: req.command, env: { ...hostCacheEnv(cache), ...userEnv } };

    const id = req.id;
    const name = containerName(id);
    const label = `${FLEET_LABEL}=${id}`;
    const cEnv = { ...containerCacheEnv(), ...userEnv };
    const flags = envFlags(Object.keys(cEnv));
    const entry = d.entrypoint ?? "sh";
    const q = (parts: string[]) => parts.map(shQuote).join(" ");
    if (d.compose && d.service) {
      const file = path.join(ws.cwd, d.compose);
      const base = ["docker", "compose", "-p", name, "-f", file];
      const run = q([
        ...base,
        "run",
        "--rm",
        "-T",
        "--label",
        label,
        "-v",
        `${cache}:/cache`,
        ...flags,
        "--entrypoint",
        entry,
        d.service,
        "-c",
        req.command,
      ]);
      return {
        command: `export COMPOSE_PROJECT_NAME=${name}; ${run}; c=$?; ${q([...base, "down", "-v", "--remove-orphans"])} >/dev/null 2>&1; exit $c`,
        env: { ...cEnv, COMPOSE_PROJECT_NAME: name },
      };
    }
    const workdir = ws.subdir ? `/w/${ws.subdir}` : "/w";
    const image = d.image ?? name;
    const runArgs = [
      "docker",
      "run",
      "--rm",
      "--name",
      name,
      "--label",
      label,
      "-v",
      `${ws.root}:/w`,
      "-w",
      workdir,
      "-v",
      `${cache}:/cache`,
      ...flags,
      ...(d.gpu ? ["--gpus", "all"] : []),
      ...resourceArgs(req.resources),
      ...(d.args ?? []),
      "--entrypoint",
      entry,
      image,
      "-c",
      req.command,
    ];
    let command = q(runArgs);
    if (!d.image && d.dockerfile) {
      const build = q([
        "docker",
        "build",
        "-t",
        name,
        "--label",
        label,
        "-f",
        path.join(ws.cwd, d.dockerfile),
        ws.cwd,
      ]);
      command = `${build} && ${command}`;
    }
    return { command, env: cEnv };
  }

  private launch(rec: JobRecord, req: JobRequest, secrets: Record<string, string>): void {
    const ws: PreparedWorkspace = { root: rec.root!, cwd: rec.cwd!, subdir: rec.subdir ?? "" };
    const { command, env } = this.buildCommand(req, ws, secrets);
    const unit = this.opts.secondsPerMinute ?? 60;
    const child = spawn("bash", ["-c", WRAPPER], {
      detached: true,
      stdio: "ignore",
      cwd: ws.cwd,
      env: {
        ...process.env,
        ...env,
        CI: "1",
        EZF_CWD: ws.cwd,
        EZF_CMD: command,
        EZF_DIR: this.runDir(req.id),
        EZF_TIMEOUT: String(Math.max(1, Math.round(req.timeoutMinutes * unit))),
        EZF_GRACE: String(this.grace),
      },
    });
    child.on("error", (e) => {
      this.appendLog(req.id, `[ezcoder node] could not start: ${e.message}`);
      void this.finalize(rec, "error", undefined, e.message);
    });
    child.unref();
    rec.wrapperPid = child.pid;
    rec.status.state = "running";
    rec.status.startedAt = new Date().toISOString();
    this.state.save();
    this.log(`job ${req.id}: running (${req.docker ? "docker" : "host"})`);
  }

  /** After a restart: a container still runs but its wrapper is gone; wait on the container. */
  private reattachContainer(rec: JobRecord): void {
    const id = rec.status.id;
    const name = containerName(id);
    const started = Date.parse(rec.status.startedAt ?? "") || Date.now();
    const left = Math.max(
      60,
      Math.round((started + rec.timeoutMinutes * 60_000 - Date.now()) / 1000),
    );
    fs.mkdirSync(this.runDir(id), { recursive: true });
    const cmd = `docker logs -f --since 1s ${shQuote(name)} & l=$!; c=$(docker wait ${shQuote(name)}); kill $l 2>/dev/null; exit \${c:-1}`;
    const child = spawn("bash", ["-c", WRAPPER], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        EZF_CWD: rec.cwd && fs.existsSync(rec.cwd) ? rec.cwd : this.runDir(id),
        EZF_CMD: cmd,
        EZF_DIR: this.runDir(id),
        EZF_TIMEOUT: String(left),
        EZF_GRACE: String(this.grace),
      },
    });
    child.on("error", () => {});
    child.unref();
    rec.wrapperPid = child.pid;
  }

  // ── polling / finalize ─────────────────────────────────────────────────
  private async pollAll(): Promise<void> {
    for (const rec of [...this.records()]) {
      if (rec.status.state !== "running") continue;
      const id = rec.status.id;
      if (fs.existsSync(path.join(this.runDir(id), "exit"))) {
        await this.collect(rec);
      } else if (rec.wrapperPid && !pidAlive(rec.wrapperPid)) {
        // Wrapper gone without writing an exit file (killed / crashed).
        await this.finalize(
          rec,
          fs.existsSync(path.join(this.runDir(id), "cancelled")) ? "cancelled" : "error",
          undefined,
          "the job runner stopped without a result",
        );
      }
    }
  }

  private readText(file: string): string | undefined {
    try {
      return fs.readFileSync(file, "utf8").trim();
    } catch {
      return undefined;
    }
  }

  private async collect(rec: JobRecord): Promise<void> {
    const dir = this.runDir(rec.status.id);
    const code = Number(this.readText(path.join(dir, "exit")) ?? "1");
    if (fs.existsSync(path.join(dir, "cancelled"))) {
      await this.finalize(rec, "cancelled", code, "cancelled");
    } else if (this.readText(path.join(dir, "timeout"))) {
      await this.finalize(rec, "failed", code, `timed out after ${rec.timeoutMinutes} min`);
    } else if (code === 0) {
      await this.finalize(rec, "passed", 0);
    } else {
      await this.finalize(rec, "failed", code, `exited ${code}`);
    }
  }

  private async finalize(
    rec: JobRecord,
    state: NodeJobState,
    exitCode?: number,
    summary?: string,
  ): Promise<void> {
    const id = rec.status.id;
    if (this.finalizing.has(id) || isTerminalJob(rec.status.state)) return;
    this.finalizing.add(id);
    try {
      if (rec.docker) await this.dockerCleanup(rec);
      if (rec.cwd && rec.artifactGlobs?.length && fs.existsSync(rec.cwd)) {
        try {
          rec.status.artifacts = await this.collectArtifacts(id, rec.cwd, rec.artifactGlobs);
        } catch (e) {
          this.appendLog(id, `[ezcoder node] artifact collection failed: ${(e as Error).message}`);
        }
      }
      try {
        cleanupWorkspace(this.cfg.dataDir, "job", id);
      } catch (e) {
        this.log(`job ${id}: workspace cleanup failed: ${(e as Error).message}`);
      }
      rec.status.state = state;
      if (exitCode !== undefined && Number.isFinite(exitCode)) rec.status.exitCode = exitCode;
      if (summary) rec.status.summary = summary;
      rec.status.finishedAt = new Date().toISOString();
      rec.status.logBytes = this.status(rec).logBytes;
      rec.wrapperPid = undefined;
      this.slots.release(id);
      if (this.find(id)) this.state.save();
      this.log(`job ${id}: ${state}${summary ? ` (${summary})` : ""}`);
    } finally {
      this.finalizing.delete(id);
    }
  }

  private async containerRunning(id: string): Promise<boolean> {
    const r = await this.exec("docker", ["ps", "-q", "--filter", `label=${FLEET_LABEL}=${id}`], {
      timeoutMs: 15_000,
    });
    return r.code === 0 && r.stdout.trim().length > 0;
  }

  private async dockerCleanup(rec: JobRecord): Promise<void> {
    const id = rec.status.id;
    const ps = await this.exec("docker", ["ps", "-aq", "--filter", `label=${FLEET_LABEL}=${id}`], {
      timeoutMs: 15_000,
    });
    const ids = ps.code === 0 ? ps.stdout.split(/\s+/).filter(Boolean) : [];
    if (ids.length) await this.exec("docker", ["rm", "-f", ...ids], { timeoutMs: 60_000 });
    if (rec.docker?.compose && rec.cwd) {
      await this.exec(
        "docker",
        [
          "compose",
          "-p",
          containerName(id),
          "-f",
          path.join(rec.cwd, rec.docker.compose),
          "down",
          "-v",
          "--remove-orphans",
        ],
        { timeoutMs: 120_000, cwd: fs.existsSync(rec.cwd) ? rec.cwd : undefined },
      );
    }
    if (!rec.docker?.image && rec.docker?.dockerfile) {
      await this.exec("docker", ["rmi", "-f", containerName(id)], { timeoutMs: 60_000 });
    }
  }

  async collectArtifacts(id: string, cwd: string, globs: string[]): Promise<ArtifactInfo[]> {
    const files = await fg(globs, {
      cwd,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      unique: true,
      suppressErrors: true,
    });
    const out: ArtifactInfo[] = [];
    let total = 0;
    const dest = this.artifactsDir(id);
    for (const rel of files.sort()) {
      if (out.length >= MAX_ARTIFACT_FILES) break;
      const src = resolveInside(cwd, rel);
      const st = fs.lstatSync(src);
      if (!st.isFile()) continue;
      // A symlinked parent folder (`link/etc/passwd`) must not pull in host files.
      if (!isRealPathInside(cwd, src)) continue;
      if (total + st.size > MAX_ARTIFACT_BYTES) break;
      const target = path.join(dest, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(src, target);
      total += st.size;
      out.push({ path: rel.split(path.sep).join("/"), bytes: st.size });
    }
    return out;
  }

  // ── reads ──────────────────────────────────────────────────────────────
  readLog(id: string, offset = 0): { data: Buffer; size: number } | undefined {
    if (!this.find(id)) return undefined;
    let fd: number;
    try {
      fd = fs.openSync(this.logFile(id), "r");
    } catch {
      return { data: Buffer.alloc(0), size: 0 };
    }
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, Math.min(offset, size));
      const len = Math.min(size - start, MAX_LOG_CHUNK);
      const data = Buffer.alloc(len);
      if (len > 0) fs.readSync(fd, data, 0, len, start);
      return { data, size };
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Absolute path of a collected artifact, or undefined. */
  artifactFile(id: string, rel: string): string | undefined {
    const rec = this.find(id);
    if (!rec?.status.artifacts?.some((a) => a.path === rel)) return undefined;
    try {
      const file = resolveInside(this.artifactsDir(id), rel);
      return fs.statSync(file).isFile() ? file : undefined;
    } catch {
      return undefined;
    }
  }

  // ── cancel / purge ─────────────────────────────────────────────────────
  async cancel(id: string): Promise<JobStatus | undefined> {
    const rec = this.find(id);
    if (!rec) return undefined;
    if (isTerminalJob(rec.status.state)) return this.status(rec);
    rec.cancelRequested = true;
    fs.mkdirSync(this.runDir(id), { recursive: true });
    fs.writeFileSync(path.join(this.runDir(id), "cancelled"), "cancelled\n");
    if (rec.status.state === "preparing") {
      this.state.save();
      return this.status(rec);
    }
    const pid = Number(this.readText(path.join(this.runDir(id), "pid")));
    const target = pid > 0 ? -pid : rec.wrapperPid ? -rec.wrapperPid : 0;
    const kill = (sig: NodeJS.Signals) => {
      if (!target) return;
      try {
        process.kill(target, sig);
      } catch {
        // already gone
      }
    };
    kill("SIGTERM");
    if (rec.docker) await this.dockerCleanup(rec);
    setTimeout(() => kill("SIGKILL"), this.grace * 1000).unref();
    this.state.save();
    return this.status(rec);
  }

  async purge(id: string): Promise<JobStatus | undefined> {
    const rec = this.find(id);
    if (!rec) return undefined;
    if (!isTerminalJob(rec.status.state)) {
      await this.cancel(id);
      rec.status.state = "cancelled";
      rec.status.summary = "cancelled";
      rec.status.finishedAt = new Date().toISOString();
      this.slots.release(id);
    }
    const last = this.status(rec);
    this.removeFiles(rec, true);
    this.state.data.jobs = this.records().filter((r) => r !== rec);
    this.state.save();
    return last;
  }

  private removeFiles(rec: JobRecord, all: boolean): void {
    const id = rec.status.id;
    try {
      fs.rmSync(workspaceRoot(this.cfg.dataDir, "job", id), { recursive: true, force: true });
      if (all) {
        fs.rmSync(this.runDir(id), { recursive: true, force: true });
        fs.rmSync(this.artifactsDir(id), { recursive: true, force: true });
      }
    } catch (e) {
      this.log(`job ${id}: cleanup failed: ${(e as Error).message}`);
    }
  }
}
