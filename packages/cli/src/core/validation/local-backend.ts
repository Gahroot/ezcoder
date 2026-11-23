// Local backend: runs a stage on this machine in a detached shell, so it keeps
// going (and its result is still collected) if EZCODER restarts meanwhile.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  BackendHealth,
  BackendPollResult,
  ValidationBackend,
  ValidationJob,
} from "./types.js";

const WRAPPER = `
set -m
cd "$EZV_CWD" || { echo 127 > "$EZV_DIR/exit"; exit; }
( eval "$EZV_CMD" ) > "$EZV_DIR/output.log" 2>&1 &
p=$!
echo $p > "$EZV_DIR/pid"
( sleep "$EZV_TIMEOUT"; echo timeout > "$EZV_DIR/timeout"; kill -TERM -- -$p 2>/dev/null ) &
w=$!
wait $p; c=$?
kill $w 2>/dev/null
echo $c > "$EZV_DIR/exit"
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return undefined;
  }
}

export class LocalBackend implements ValidationBackend {
  readonly id = "local";
  readonly kind = "local";
  readonly runs = "local" as const;

  constructor(
    private readonly logsDir: string,
    readonly maxConcurrent = 2,
  ) {}

  private dir(job: ValidationJob): string {
    return path.join(this.logsDir, job.id);
  }

  async dispatch(job: ValidationJob): Promise<{ runId?: string; url?: string }> {
    const dir = this.dir(job);
    fs.mkdirSync(dir, { recursive: true });
    const child = spawn("bash", ["-c", WRAPPER], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        EZV_CWD: job.project,
        EZV_CMD: job.command,
        EZV_DIR: dir,
        EZV_TIMEOUT: String(job.timeoutMinutes * 60),
        CI: "1",
      },
    });
    child.unref();
    return { runId: String(child.pid ?? ""), url: path.join(dir, "output.log") };
  }

  async poll(job: ValidationJob): Promise<BackendPollResult> {
    const dir = this.dir(job);
    const exit = readText(path.join(dir, "exit"));
    if (exit !== undefined) {
      if (readText(path.join(dir, "timeout"))) {
        return { state: "failed", summary: `timed out after ${job.timeoutMinutes} min` };
      }
      return exit === "0" ? { state: "passed" } : { state: "failed", summary: `exited ${exit}` };
    }
    const pid = Number(job.runId);
    if (pid && alive(pid)) return { state: "running" };
    return { state: "error", summary: "the local run stopped without a result" };
  }

  async logs(job: ValidationJob): Promise<string> {
    const text = readText(path.join(this.dir(job), "output.log"));
    if (text === undefined) return "No output yet.";
    return text.length > 24_000 ? `…\n${text.slice(-24_000)}` : text || "(no output)";
  }

  async cancel(job: ValidationJob): Promise<void> {
    const pid = Number(readText(path.join(this.dir(job), "pid")));
    if (pid) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }

  async health(): Promise<BackendHealth> {
    return { online: true, detail: "this machine" };
  }
}
