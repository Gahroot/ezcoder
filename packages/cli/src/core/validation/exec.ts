import { execFile } from "node:child_process";
import type { Exec } from "./types.js";

/** Run a program without a shell; never throws, the exit code says how it went. */
export const defaultExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: 32 * 1024 * 1024,
        ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException).code === "number"
            ? (err as unknown as { code: number }).code
            : err
              ? 1
              : 0;
        resolve({
          code,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? "") || (err && code !== 0 && !stderr ? err.message : ""),
        });
      },
    );
  });
