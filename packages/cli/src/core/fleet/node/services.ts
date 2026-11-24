// Long-running services on a fleet node: detached Docker containers
// (`restart unless-stopped`) published on the node's bind address at a free
// host port, reachable by the controller at advertiseHost. Inference servers,
// remote Playwright browsers and dev environments (`devenv`) all go here.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type {
  ExecRequest,
  ExecResponse,
  ServiceEndpoint,
  ServiceKind,
  ServiceRequest,
  ServiceStatus,
  SourceSpec,
} from "../protocol.js";
import type { NodeConfig } from "./context.js";
import {
  containerName,
  envFlags,
  FLEET_LABEL,
  isValidEnvName,
  isValidImage,
  resourceArgs,
  validateDockerArgs,
  SERVICE_LABEL,
  validateDockerSpec,
  VOLUME_LABEL,
} from "./docker.js";
import { isSafeId, type NodeExec } from "./exec.js";
import type { ApiResult } from "./jobs.js";
import type { ServiceRecord, StateStore } from "./state.js";
import {
  cleanupWorkspace,
  isRealPathInside,
  prepareWorkspaceDetailed,
  type PreparedWorkspace,
} from "./workspace.js";

const SERVICE_KINDS: ReadonlySet<ServiceKind> = new Set([
  "inference",
  "browser",
  "devenv",
  "custom",
]);
const MAX_EXEC_OUTPUT = 1024 * 1024;

export interface ServiceManagerOptions {
  config: NodeConfig;
  state: StateStore;
  exec: NodeExec;
  log?: (msg: string) => void;
  dockerAvailable?: () => Promise<boolean>;
  prepare?: (
    kind: "service",
    id: string,
    source: SourceSpec | undefined,
  ) => Promise<PreparedWorkspace>;
  /** Pick a free host port on the bind address. */
  freePort?: (host: string) => Promise<number>;
  idleCheckMs?: number;
}

export function freePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, host || "0.0.0.0", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Strip // and /* *\/ comments and trailing commas from JSONC (strings respected). */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
    } else if (c === '"') {
      inStr = true;
      out += c;
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export type DevenvImage = { image: string } | { dockerfile: string; context: string };

/**
 * devcontainer image / Dockerfile, a workspace Dockerfile, else a language image.
 * The repo is untrusted input: images must be plain references (never flags) and
 * Dockerfile/context must stay inside `root` (default `cwd`), symlinks included.
 */
export function resolveDevenvImage(cwd: string, root = cwd): DevenvImage {
  for (const rel of [".devcontainer/devcontainer.json", ".devcontainer.json"]) {
    const file = path.join(cwd, rel);
    if (!fs.existsSync(file)) continue;
    try {
      const dc = parseJsonc(fs.readFileSync(file, "utf8")) as {
        image?: string;
        dockerFile?: string;
        build?: { dockerfile?: string; context?: string };
      };
      if (dc.image) {
        if (typeof dc.image !== "string" || !isValidImage(dc.image)) {
          throw new Error(`invalid devcontainer image: ${String(dc.image)}`);
        }
        return { image: dc.image };
      }
      const df = dc.build?.dockerfile ?? dc.dockerFile;
      if (df) {
        const base = path.dirname(file);
        const dockerfile = path.resolve(base, String(df));
        const context = path.resolve(base, String(dc.build?.context ?? "."));
        if (!isRealPathInside(root, dockerfile) || !isRealPathInside(root, context)) {
          throw new Error("devcontainer Dockerfile and context must stay inside the workspace");
        }
        return { dockerfile, context };
      }
    } catch (e) {
      if (e instanceof Error && /^(invalid devcontainer|devcontainer Dockerfile)/.test(e.message))
        throw e;
      // unreadable devcontainer: fall through
    }
  }
  if (fs.existsSync(path.join(cwd, "Dockerfile"))) {
    return { dockerfile: path.join(cwd, "Dockerfile"), context: cwd };
  }
  const has = (f: string) => fs.existsSync(path.join(cwd, f));
  if (has("package.json")) return { image: "node:22" };
  if (has("pyproject.toml") || has("requirements.txt")) return { image: "python:3.12" };
  if (has("go.mod")) return { image: "golang:1.23" };
  if (has("Cargo.toml")) return { image: "rust:1" };
  if (has("Gemfile")) return { image: "ruby:3.3" };
  return { image: "ubuntu:24.04" };
}

export function endpointUrl(
  host: string,
  hostPort: number,
  protocol: "http" | "ws" | "tcp" = "http",
): string {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${protocol}://${h}:${hostPort}`;
}

export function persistVolumeName(persist: string): string {
  return `ezf-vol-${persist.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-")}`;
}

export class ServiceManager {
  private readonly cfg: NodeConfig;
  private readonly state: StateStore;
  private readonly exec: NodeExec;
  private readonly log: (msg: string) => void;
  private timer?: ReturnType<typeof setInterval>;
  private pending = new Map<string, Promise<void>>();

  constructor(private readonly opts: ServiceManagerOptions) {
    this.cfg = opts.config;
    this.state = opts.state;
    this.exec = opts.exec;
    this.log = opts.log ?? (() => {});
  }

  private records(): ServiceRecord[] {
    return this.state.data.services;
  }
  private find(id: string): ServiceRecord | undefined {
    return this.records().find((r) => r.status.id === id);
  }

  async init(): Promise<void> {
    for (const rec of this.records()) {
      if (rec.status.state === "starting") {
        rec.status.state = "running"; // let refresh decide from the real container
        rec.status.summary = undefined;
      }
    }
    if (this.records().length) await this.refresh(true);
    this.timer = setInterval(() => void this.idleTick(), this.opts.idleCheckMs ?? 60_000);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Sync states with Docker (one `docker ps`). Containers survive node restarts. */
  async refresh(save = false): Promise<void> {
    const watched = this.records().filter((r) => r.status.state !== "starting");
    if (!watched.length) return;
    const r = await this.exec(
      "docker",
      [
        "ps",
        "-a",
        "--filter",
        `label=${SERVICE_LABEL}`,
        "--format",
        `{{.Label "${SERVICE_LABEL}"}}\t{{.State}}`,
      ],
      { timeoutMs: 15_000 },
    );
    if (r.code !== 0) return;
    const live = new Map<string, string>();
    for (const line of r.stdout.split("\n")) {
      const [id, st] = line.trim().split("\t");
      if (id && st) live.set(id, st);
    }
    let changed = false;
    for (const rec of watched) {
      const st = live.get(rec.status.id);
      const next =
        st === "running"
          ? "running"
          : st === "restarting"
            ? "error"
            : st === undefined
              ? rec.status.state === "running"
                ? "error"
                : rec.status.state
              : "stopped";
      if (next !== rec.status.state) {
        rec.status.state = next;
        rec.status.summary =
          next === "error"
            ? st === "restarting"
              ? "container keeps crashing and restarting; check the service log"
              : "container is gone"
            : next === "stopped"
              ? `container ${st}`
              : undefined;
        changed = true;
      }
    }
    if (changed || save) this.state.save();
  }

  async list(): Promise<ServiceStatus[]> {
    await this.refresh();
    return this.records().map((r) => ({ ...r.status }));
  }

  snapshot(): ServiceStatus[] {
    return this.records().map((r) => ({ ...r.status }));
  }

  async get(id: string): Promise<ServiceStatus | undefined> {
    if (!this.find(id)) return undefined;
    await this.refresh();
    const rec = this.find(id);
    return rec && { ...rec.status };
  }

  validate(req: ServiceRequest): string | undefined {
    if (!req || typeof req !== "object") return "body must be a ServiceRequest";
    if (!isSafeId(req.id)) return "invalid service id";
    if (!SERVICE_KINDS.has(req.kind)) return `invalid service kind: ${String(req.kind)}`;
    if (!req.docker || typeof req.docker !== "object") return "docker is required";
    if (req.docker.compose) return "compose is not supported for services";
    if (!Array.isArray(req.ports)) return "ports must be an array";
    for (const p of req.ports) {
      if (!Number.isInteger(p?.container) || p.container < 1 || p.container > 65535)
        return "invalid container port";
      if (typeof p.name !== "string" || !p.name) return "every port needs a name";
      if (p.protocol && !["http", "ws", "tcp"].includes(p.protocol))
        return `invalid protocol: ${p.protocol}`;
    }
    if (req.persist !== undefined && !isSafeId(req.persist)) return "invalid persist volume name";
    for (const [k, v] of Object.entries(req.env ?? {})) {
      if (!isValidEnvName(k) || typeof v !== "string") return `invalid env var: ${k}`;
    }
    if (req.command !== undefined && typeof req.command !== "string")
      return "command must be a string";
    const d = req.docker;
    if (req.kind === "devenv" && !d.image && !d.dockerfile) {
      // image resolved from the workspace; still validate args
      return validateDockerSpec({ ...d, image: "placeholder" }, this.cfg.dataDir);
    }
    return validateDockerSpec(d, this.cfg.dataDir);
  }

  async submit(req: ServiceRequest): Promise<ApiResult> {
    const invalid = this.validate(req);
    if (invalid) return { status: 400, body: { error: invalid } };
    const existing = this.find(req.id);
    if (existing && (existing.status.state === "running" || existing.status.state === "starting")) {
      return { status: 200, body: { ...existing.status } };
    }
    if (this.opts.dockerAvailable && !(await this.opts.dockerAvailable())) {
      return { status: 409, body: { error: "docker is not available on this node" } };
    }
    if (existing) this.state.data.services = this.records().filter((r) => r !== existing);
    const rec: ServiceRecord = {
      status: {
        id: req.id,
        kind: req.kind,
        project: req.project,
        state: "starting",
        endpoints: [],
        startedAt: new Date().toISOString(),
      },
      ports: [],
      idleStopMinutes: req.idleStopMinutes,
      lastActiveAt: new Date().toISOString(),
    };
    this.records().push(rec);
    this.state.save();
    const started = this.start(rec, req).finally(() => this.pending.delete(req.id));
    this.pending.set(req.id, started);
    return { status: 201, body: { ...rec.status } };
  }

  /** Resolves when the service's start attempt (build, pull, run) has finished. */
  async settled(id: string): Promise<void> {
    await this.pending.get(id);
  }

  /** Build the `docker run -d` argv for a service (exported for tests). */
  runArgs(
    req: ServiceRequest,
    image: string,
    ports: Array<{ container: number; hostPort: number }>,
    ws: PreparedWorkspace | undefined,
  ): { args: string[]; env: Record<string, string> } {
    const d = req.docker;
    const id = req.id;
    const bind = this.cfg.bind;
    const env: Record<string, string> = { ...(req.env ?? {}) };
    const args = [
      "run",
      "-d",
      "--name",
      containerName(id),
      "--label",
      `${FLEET_LABEL}=${id}`,
      "--label",
      `${SERVICE_LABEL}=${id}`,
      "--restart",
      "unless-stopped",
    ];
    for (const p of ports) {
      args.push(
        "-p",
        bind ? `${bind}:${p.hostPort}:${p.container}` : `${p.hostPort}:${p.container}`,
      );
    }
    if (ws) args.push("-v", `${ws.root}:/w`, "-w", ws.subdir ? `/w/${ws.subdir}` : "/w");
    if (req.persist) {
      args.push("-v", `${persistVolumeName(req.persist)}:/persist`);
      env.HOME ??= "/persist";
      env.XDG_CACHE_HOME ??= "/persist/.cache";
    }
    args.push(...envFlags(Object.keys(env)));
    if (d.gpu) args.push("--gpus", "all");
    args.push(...resourceArgs(req.resources), ...(d.args ?? []));
    if (req.command) {
      args.push("--entrypoint", d.entrypoint ?? "sh", image, "-c", req.command);
    } else if (req.kind === "devenv") {
      args.push("--entrypoint", "sleep", image, "infinity");
    } else {
      if (d.entrypoint) args.push("--entrypoint", d.entrypoint);
      args.push(image);
    }
    return { args, env };
  }

  private async start(rec: ServiceRecord, req: ServiceRequest): Promise<void> {
    const id = req.id;
    const fail = (summary: string) => {
      rec.status.state = "error";
      rec.status.summary = summary.trim().split("\n").slice(-3).join(" ").slice(0, 400);
      this.state.save();
      this.log(`service ${id}: error (${rec.status.summary})`);
    };
    try {
      const d = req.docker;
      let ws: PreparedWorkspace | undefined;
      if (req.source || req.kind === "devenv") {
        ws = await (this.opts.prepare
          ? this.opts.prepare("service", id, req.source)
          : prepareWorkspaceDetailed({
              dataDir: this.cfg.dataDir,
              kind: "service",
              id,
              source: req.source,
              exec: this.exec,
            }));
      }
      // Re-check host mounts now that the workspace (and any symlinks in it) exists.
      const argsErr = validateDockerArgs(d.args, this.cfg.dataDir);
      if (argsErr) return fail(argsErr);
      let image = d.image;
      let build: { dockerfile: string; context: string } | undefined;
      if (!image && d.dockerfile) {
        if (!ws) return fail("docker.dockerfile needs a source");
        build = { dockerfile: path.join(ws.cwd, d.dockerfile), context: ws.cwd };
        if (!isRealPathInside(ws.root, build.dockerfile))
          return fail("docker.dockerfile must stay inside the workspace");
      } else if (!image && req.kind === "devenv" && ws) {
        const picked = resolveDevenvImage(ws.cwd, ws.root);
        if ("image" in picked) image = picked.image;
        else build = picked;
      }
      if (build) {
        const b = await this.exec(
          "docker",
          [
            "build",
            "-t",
            containerName(id),
            "--label",
            `${FLEET_LABEL}=${id}`,
            "-f",
            build.dockerfile,
            build.context,
          ],
          { timeoutMs: 60 * 60_000 },
        );
        if (b.code !== 0) return fail(`docker build failed: ${b.stderr || b.stdout}`);
        image = containerName(id);
        rec.builtImage = true;
      }
      if (!image) return fail("no image");
      rec.image = image;
      if (req.persist) {
        await this.exec(
          "docker",
          [
            "volume",
            "create",
            "--label",
            `${VOLUME_LABEL}=${req.persist}`,
            persistVolumeName(req.persist),
          ],
          { timeoutMs: 30_000 },
        );
      }
      const pick = this.opts.freePort ?? freePort;
      const ports = [];
      for (const p of req.ports) ports.push({ ...p, hostPort: await pick(this.cfg.bind) });
      rec.ports = ports;
      rec.workspace = Boolean(ws);
      await this.exec("docker", ["rm", "-f", containerName(id)], { timeoutMs: 30_000 });
      const { args, env } = this.runArgs(req, image, ports, ws);
      const r = await this.exec("docker", args, {
        timeoutMs: 60 * 60_000, // first run may pull a large image
        env: { ...process.env, ...env },
      });
      if (this.find(id) !== rec) return; // removed meanwhile
      if (r.code !== 0) return fail(`docker run failed: ${r.stderr || r.stdout}`);
      const host = this.cfg.advertiseHost || this.cfg.bind;
      rec.status.endpoints = ports.map((p): ServiceEndpoint => ({
        name: p.name,
        url: endpointUrl(host, p.hostPort, p.protocol),
      }));
      rec.status.state = "running";
      rec.status.summary = undefined;
      rec.lastActiveAt = new Date().toISOString();
      this.state.save();
      this.log(`service ${id}: running (${image})`);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  }

  async remove(id: string): Promise<ServiceStatus | undefined> {
    const rec = this.find(id);
    if (!rec) return undefined;
    this.state.data.services = this.records().filter((r) => r !== rec);
    this.state.save();
    await this.exec("docker", ["rm", "-f", containerName(id)], { timeoutMs: 60_000 });
    if (rec.builtImage)
      await this.exec("docker", ["rmi", "-f", containerName(id)], { timeoutMs: 60_000 });
    try {
      cleanupWorkspace(this.cfg.dataDir, "service", id);
    } catch (e) {
      this.log(`service ${id}: workspace cleanup failed: ${(e as Error).message}`);
    }
    return { ...rec.status, state: "stopped", endpoints: [] };
  }

  async logs(id: string, tail = 500): Promise<string | undefined> {
    const rec = this.find(id);
    if (!rec) return undefined;
    rec.lastActiveAt = new Date().toISOString();
    const n = Math.max(1, Math.min(Math.floor(tail) || 500, 100_000));
    const r = await this.exec("docker", ["logs", "--tail", String(n), containerName(id)], {
      timeoutMs: 30_000,
    });
    return r.stdout + (r.stderr ? (r.stdout ? "\n" : "") + r.stderr : "");
  }

  async execIn(id: string, req: ExecRequest): Promise<ApiResult> {
    const rec = this.find(id);
    if (!rec) return { status: 404, body: { error: "no such service" } };
    if (rec.status.kind !== "devenv" && rec.status.kind !== "custom") {
      return {
        status: 400,
        body: { error: "exec is only available for devenv and custom services" },
      };
    }
    if (!req || typeof req.command !== "string" || !req.command.trim()) {
      return { status: 400, body: { error: "command is required" } };
    }
    if (rec.status.state !== "running")
      return { status: 409, body: { error: `service is ${rec.status.state}` } };
    if (req.cwd !== undefined && (typeof req.cwd !== "string" || req.cwd.includes("\0"))) {
      return { status: 400, body: { error: "invalid cwd" } };
    }
    rec.lastActiveAt = new Date().toISOString();
    const base = rec.workspace ? "/w" : undefined;
    const cwd = req.cwd
      ? req.cwd.startsWith("/")
        ? req.cwd
        : path.posix.join(base ?? "/", req.cwd)
      : base;
    const timeout = Math.max(1, Math.min(req.timeoutSeconds ?? 600, 3600));
    const r = await this.exec(
      "docker",
      ["exec", ...(cwd ? ["-w", cwd] : []), containerName(id), "sh", "-lc", req.command],
      { timeoutMs: timeout * 1000, maxBytes: MAX_EXEC_OUTPUT },
    );
    rec.lastActiveAt = new Date().toISOString();
    let output =
      r.stdout + (r.stderr ? (r.stdout && !r.stdout.endsWith("\n") ? "\n" : "") + r.stderr : "");
    if (output.length > MAX_EXEC_OUTPUT) output = output.slice(-MAX_EXEC_OUTPUT);
    const body: ExecResponse = { exitCode: r.code, output };
    return { status: 200, body };
  }

  /** Stop services idle (CPU < 2% and no API use) longer than idleStopMinutes. */
  async idleTick(now = Date.now()): Promise<void> {
    for (const rec of this.records()) {
      const mins = rec.idleStopMinutes ?? 0;
      if (rec.status.state !== "running" || mins <= 0) continue;
      const s = await this.exec(
        "docker",
        ["stats", "--no-stream", "--format", "{{.CPUPerc}}", containerName(rec.status.id)],
        { timeoutMs: 30_000 },
      );
      const cpu = parseFloat(s.stdout);
      if (s.code === 0 && Number.isFinite(cpu) && cpu >= 2) {
        rec.lastActiveAt = new Date(now).toISOString();
        continue;
      }
      const last = Date.parse(rec.lastActiveAt ?? rec.status.startedAt ?? "") || now;
      if (now - last >= mins * 60_000) {
        await this.exec("docker", ["stop", containerName(rec.status.id)], { timeoutMs: 60_000 });
        rec.status.state = "stopped";
        rec.status.summary = `stopped after ${mins} idle min`;
        this.state.save();
        this.log(`service ${rec.status.id}: ${rec.status.summary}`);
      }
    }
  }
}
