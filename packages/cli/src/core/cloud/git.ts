// Small git helpers for cloud tasks (no shell; binary-safe).
import { spawn } from "node:child_process";

export interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export function runGit(
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

export async function git(
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

/** owner/name from a GitHub remote URL, else undefined. */
export function githubRepoFromUrl(url: string): string | undefined {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}
