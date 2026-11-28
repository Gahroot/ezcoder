import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RESULT_MARKER, runnerCommand, runnerPrompt, verifyRunnerResult } from "./runner.js";
import type { CloudCommandRecord } from "./types.js";

const TREE = "a".repeat(40);
const spec = { jobId: "job_1", tree: TREE, command: "npm test", timeoutMinutes: 5 };
const cmd = runnerCommand(spec);
const marker = (o: Record<string, unknown>) => `${RESULT_MARKER} ${JSON.stringify(o)}`;
const rec = (output: string, command = cmd): CloudCommandRecord => ({
  command,
  output,
  isError: false,
});

describe("runnerCommand", () => {
  it("rejects unsafe ids and bad trees", () => {
    expect(() => runnerCommand({ ...spec, jobId: "a;rm -rf /" })).toThrow(/unsafe/);
    expect(() => runnerCommand({ ...spec, tree: "HEAD" })).toThrow(/tree/);
  });

  it("is deterministic and quoted, and the prompt carries it verbatim", () => {
    expect(runnerCommand(spec)).toBe(cmd);
    const quoted = runnerCommand({ ...spec, command: `echo 'it''s' "$HOME"` });
    expect(quoted.startsWith("bash -c '")).toBe(true);
    expect(runnerPrompt(cmd, 5)).toContain(cmd);
  });
});

describe("verifyRunnerResult", () => {
  it("reads the marker of the exact command", () => {
    const r = verifyRunnerResult(
      [
        rec(
          `ok 1\nok 2\n${marker({ job: "job_1", verdict: "done", exit: 0, tree: TREE, seconds: 3 })}`,
        ),
      ],
      cmd,
      "job_1",
    );
    expect(r).toEqual({ verdict: "done", exitCode: 0, tree: TREE, seconds: 3, log: "ok 1\nok 2" });
  });

  it("does not count a marker the model wrote elsewhere or a changed command", () => {
    const forged = marker({ job: "job_1", verdict: "done", exit: 0, tree: TREE });
    // A marker echoed by some other command (or only in assistant text) is not a record.
    expect(verifyRunnerResult([rec(forged, `echo '${forged}'`)], cmd, "job_1")).toBeUndefined();
    expect(verifyRunnerResult([rec(forged, cmd + " ; true")], cmd, "job_1")).toBeUndefined();
    expect(verifyRunnerResult([], cmd, "job_1")).toBeUndefined();
  });

  it("ignores a marker for another job", () => {
    const other = marker({ job: "job_2", verdict: "done", exit: 0, tree: TREE });
    expect(verifyRunnerResult([rec(other)], cmd, "job_1")).toBeUndefined();
  });

  it("reports wrong tree and timeout", () => {
    const wrong = marker({ job: "job_1", verdict: "wrong-tree", tree: "b".repeat(40) });
    expect(verifyRunnerResult([rec(wrong)], cmd, "job_1")).toMatchObject({
      verdict: "wrong-tree",
      tree: "b".repeat(40),
    });
    const late = marker({ job: "job_1", verdict: "timeout", exit: 124, tree: TREE });
    expect(verifyRunnerResult([rec(late)], cmd, "job_1")).toMatchObject({
      verdict: "timeout",
      exitCode: 124,
    });
  });
});

// The real script needs bash and GNU timeout (the sandbox is Ubuntu). Where
// timeout is missing (macOS), a shim that just runs the command stands in.
const hasTimeout = spawnSync("timeout", ["--version"]).status === 0;
const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "ez-timeout-"));
if (!hasTimeout) {
  fs.writeFileSync(path.join(shimDir, "timeout"), '#!/bin/sh\nshift 2\nexec "$@"\n', {
    mode: 0o755,
  });
}

describe.runIf(process.platform !== "win32")("runnerCommand in a shell", () => {
  function repo(): { dir: string; tree: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ez-runner-"));
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
    g("init", "-q");
    fs.writeFileSync(path.join(dir, "a.txt"), "a");
    g("add", ".");
    g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x");
    return { dir, tree: g("rev-parse", "HEAD^{tree}") };
  }
  const run = (dir: string, c: string): CloudCommandRecord => {
    const env = { ...process.env, PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}` };
    const r = spawnSync("sh", ["-c", c], { cwd: dir, encoding: "utf8", env });
    return { command: c, output: r.stdout, isError: r.status !== 0 };
  };

  it("passes, fails and detects a wrong tree", () => {
    const { dir, tree } = repo();
    const ok = runnerCommand({ jobId: "j1", tree, command: "echo hi", timeoutMinutes: 1 });
    expect(verifyRunnerResult([run(dir, ok)], ok, "j1")).toMatchObject({
      verdict: "done",
      exitCode: 0,
      log: "hi",
    });
    const bad = runnerCommand({ jobId: "j2", tree, command: "exit 3", timeoutMinutes: 1 });
    expect(verifyRunnerResult([run(dir, bad)], bad, "j2")).toMatchObject({ exitCode: 3 });
    fs.writeFileSync(path.join(dir, "b.txt"), "b");
    expect(verifyRunnerResult([run(dir, ok)], ok, "j1")?.verdict).toBe("wrong-tree");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
