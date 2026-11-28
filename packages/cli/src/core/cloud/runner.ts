// The one command a cloud sandbox runs for a validation stage or job, and the
// check that a result really came from it.
//
// The model only relays: it is told to run one exact command. The provider's
// harness records that command and its real output (Claude: the Bash
// tool_result; Codex: the work log). A result counts only when the recorded
// command is byte-identical to ours and its output ends with our marker line
// carrying this job's id and the expected tree hash, so a model summary can
// never pass for a test result, and a sandbox holding other code can't either.
import type { CloudCommandRecord } from "./types.js";

export const RESULT_MARKER = "EZCLOUD-RESULT";

/** Bytes of log the command prints back (the harness keeps the tail). */
export const LOG_TAIL_BYTES = 40_000;

export interface RunnerSpec {
  /** Job id (letters, digits, - and _ only). */
  jobId: string;
  /** Tree hash the working copy must have before the command runs. */
  tree: string;
  /** Shell command of the stage/job. */
  command: string;
  timeoutMinutes: number;
  /**
   * Run the command as an unprivileged user (created in the sandbox).
   * Default off: sandboxes run as root, and the sandbox's model refused to
   * create users and change ownership when asked to (measured live). Root
   * ignores file permissions, so permission tests can fail there.
   */
  nonRoot?: boolean;
  /** Start the sandbox's Docker daemon first (stages/jobs that use Docker). */
  docker?: boolean;
  /** Folder of the checkout in the sandbox ("" = current directory). */
  dir?: string;
}

export interface RunnerResult {
  verdict: "done" | "wrong-tree" | "timeout";
  exitCode?: number;
  /** Tree the sandbox actually had. */
  tree?: string;
  seconds?: number;
  /** Log tail printed by the command (without the marker line). */
  log: string;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The exact command line for the sandbox. Self-contained: it checks the tree,
 * runs the stage with a timeout, prints the log tail and the marker line.
 */
export function runnerCommand(spec: RunnerSpec): string {
  if (!SAFE_ID.test(spec.jobId)) throw new Error(`unsafe job id: ${spec.jobId}`);
  if (!/^[0-9a-f]{40,64}$/.test(spec.tree)) throw new Error(`bad tree hash: ${spec.tree}`);
  const minutes = Math.max(1, Math.ceil(spec.timeoutMinutes));
  const log = `/tmp/ezcloud-${spec.jobId}.log`;
  const marker = (fields: string) =>
    `printf '%s {"job":"%s",${fields}}\\n' ${RESULT_MARKER} ${spec.jobId}`;
  const script = [
    spec.dir ? `cd ${shellQuote(spec.dir)} || exit 0` : "",
    // Tree of the working copy as it is (tracked + untracked, not ignored).
    // A private index (fixed path; an empty mktemp file is not a valid index)
    // seeded from HEAD, so tracked files that match .gitignore stay in the
    // tree; add -A then folds in every edit, removal and untracked file. No
    // rm: rm makes the sandbox ask for permission.
    `export GIT_INDEX_FILE=/tmp/ezcloud-${spec.jobId}.index; git read-tree HEAD 2>/dev/null || git read-tree --empty; git add -A >/dev/null 2>&1; got=$(git write-tree 2>/dev/null); unset GIT_INDEX_FILE`,
    `if [ "$got" != "${spec.tree}" ]; then ${marker(`"verdict":"wrong-tree","tree":"%s"`)} "$got"; exit 0; fi`,
    `start=$(date +%s)`,
    // Cloud sandboxes ship the docker CLI but no running daemon; root can start one (~5 s).
    spec.docker
      ? `if ! docker info >/dev/null 2>&1; then (sudo -n dockerd >/tmp/ezcloud-dockerd.log 2>&1 &); for i in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done; sudo -n chmod 666 /var/run/docker.sock 2>/dev/null; fi`
      : "",
    !spec.nonRoot
      ? `runas=""`
      : `runas=""; if [ "$(id -u)" = 0 ]; then id ezrun >/dev/null 2>&1 || useradd -m -s /bin/bash ezrun >/dev/null 2>&1; if id ezrun >/dev/null 2>&1; then chown -R ezrun "$PWD"; runas="sudo -u ezrun -H --preserve-env=PATH,CI"; fi; fi`,
    `timeout --kill-after=30 ${minutes}m $runas bash -c ${shellQuote(spec.command)} > ${log} 2>&1 < /dev/null; code=$?`,
    `tail -c ${LOG_TAIL_BYTES} ${log}`,
    `echo`,
    `verdict=done; if [ $code -eq 124 ] || [ $code -eq 137 ]; then verdict=timeout; fi`,
    `${marker(`"verdict":"%s","exit":%s,"tree":"%s","seconds":%s`)} "$verdict" "$code" "$got" "$(( $(date +%s) - start ))"`,
  ]
    .filter(Boolean)
    .join("\n");
  return `bash -c ${shellQuote(script)}`;
}

/** The instruction for the sandbox's model. */
export function runnerPrompt(command: string, timeoutMinutes: number): string {
  const ms = Math.min(Math.max(1, Math.ceil(timeoutMinutes) + 5) * 60_000, 24 * 3_600_000);
  return [
    "You are a test runner. Do exactly one thing:",
    `run the command below with your shell tool, copied byte for byte, in the repository folder, with a timeout of ${ms} ms.`,
    "Do not change, fix, retry, split or explain it. Do not edit any file. Do not run anything else.",
    `When it finishes, reply with only the last line of its output (the line starting with ${RESULT_MARKER}).`,
    "",
    "```bash",
    command,
    "```",
  ].join("\n");
}

/**
 * Find the harness record of `command` and read the marker for `jobId`.
 * Undefined when the sandbox never ran that exact command (or its output has
 * no marker for this job): the result is then unverified and must not count.
 */
export function verifyRunnerResult(
  records: readonly CloudCommandRecord[],
  command: string,
  jobId: string,
): RunnerResult | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]!;
    if (record.command.trim() !== command.trim()) continue;
    const lines = record.output.replace(/\r/g, "").split("\n");
    for (let j = lines.length - 1; j >= 0; j--) {
      const line = lines[j]!.trim();
      if (!line.startsWith(`${RESULT_MARKER} `)) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line.slice(RESULT_MARKER.length + 1)) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (parsed.job !== jobId) continue;
      const verdict = parsed.verdict;
      if (verdict !== "done" && verdict !== "wrong-tree" && verdict !== "timeout") continue;
      return {
        verdict,
        ...(typeof parsed.exit === "number" && { exitCode: parsed.exit }),
        ...(typeof parsed.tree === "string" && { tree: parsed.tree }),
        ...(typeof parsed.seconds === "number" && { seconds: parsed.seconds }),
        log: lines.slice(0, j).join("\n").trimEnd(),
      };
    }
  }
  return undefined;
}
