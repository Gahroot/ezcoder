// Process helpers for the fleet node. Every external program (git, docker,
// tailscale, nvidia-smi …) goes through a NodeExec so tests can inject a fake.
import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  /** Replaces the environment entirely when set (merge process.env yourself). */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  /** Keep only the last N bytes of stdout+stderr (default 32 MB each). */
  maxBytes?: number;
}

/** Run a program without a shell. Never throws: a missing binary is code 127. */
export type NodeExec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

export const defaultExec: NodeExec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const max = opts.maxBytes ?? 32 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ code: 127, stdout: "", stderr: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ code: 124, stdout, stderr: stderr + `\n${cmd} timed out` });
    }, opts.timeoutMs ?? 60_000);
    child.stdout?.on("data", (d: Buffer) => {
      stdout = (stdout + d.toString()).slice(-max);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-max);
    });
    child.on("error", (e: NodeJS.ErrnoException) =>
      done({ code: e.code === "ENOENT" ? 127 : 1, stdout, stderr: stderr || e.message }),
    );
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });

/** Single-quote a string for POSIX sh. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** True when `pid` is a live process (EPERM still means it exists). */
export function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Ids name folders, containers and labels: keep them boring. */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeId(id: unknown): id is string {
  return typeof id === "string" && SAFE_ID.test(id) && !id.includes("..");
}
