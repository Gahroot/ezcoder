/**
 * Verification gate — the turn cannot claim "done" while a promised check is
 * still owed.
 *
 * When a run mutated code files and no test / typecheck / lint / build command
 * completed after the last mutation, the pre-stop hook injects a follow-up
 * demanding the project's verification be run, and blocks completion until it
 * is (or the budget escalates to an honest "this went unverified" statement).
 * Prompt-only "verify before finishing" instructions can be ignored; this gate
 * is harness-owned bookkeeping on what actually executed.
 *
 * Simplification: verification is recognised by a conservative runner-shape
 * classifier (package-manager/runner + test/lint/check keyword). Both error
 * directions are safe — a missed recognition leaves the gate silent (today's
 * behavior), a false positive merely skips one continuation.
 */
import type { Message } from "@prestyj/ai";

/** Follow-ups per run before the gate escalates to "state what went unverified". */
export const MAX_VERIFICATION_INJECTIONS = 1;

/** Words that may precede the real command without changing its shape. */
const SHELL_WRAPPERS = new Set([
  "env",
  "nohup",
  "nice",
  "time",
  "sudo",
  "stdbuf",
  "command",
  "exec",
]);

/** Leading words that mark a command as a build/test-tool invocation. Anything
 *  else (git, grep, ./script.sh, bash …) is conservatively not verification. */
const RUNNERS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "nr",
  "deno",
  "python",
  "python3",
  "py",
  "uv",
  "go",
  "cargo",
  "rustc",
  "make",
  "cmake",
  "gradle",
  "mvn",
  "dotnet",
  "sbt",
  "swift",
  "tsc",
  "vitest",
  "jest",
  "mocha",
  "pytest",
  "unittest",
  "eslint",
  "biome",
  "ruff",
  "mypy",
  "pylint",
]);

/** A non-flag word after the runner that makes the command a verification. */
const VERIFY_KEYWORDS = [
  "test",
  "tests",
  "vitest",
  "jest",
  "mocha",
  "pytest",
  "unittest",
  "tsc",
  "typecheck",
  "type-check",
  "eslint",
  "biome",
  "ruff",
  "mypy",
  "pylint",
  "lint",
  "clippy",
  "vet",
  "check",
  "build",
  "compile",
  "verify",
];

function isVerifyWord(word: string): boolean {
  // Exact keyword, or a script name built on one (npm run test:unit).
  return VERIFY_KEYWORDS.some((keyword) => word === keyword || word.startsWith(`${keyword}:`));
}

/**
 * True when the command looks like a test/typecheck/lint/build invocation:
 * wrappers stripped, a known runner leading, and a verification keyword among
 * its operands. Deliberately strict — `grep test x`, `git commit -m test` and
 * `./run_tests.sh` all read as NOT verification.
 */
export function isVerificationCommand(command: string): boolean {
  const words = command.trim().split(/\s+/);
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    if (SHELL_WRAPPERS.has(word) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      i += 1;
      continue;
    }
    // `timeout <duration> runner …` — skip the duration argument too.
    if (word === "timeout") {
      i += 2;
      continue;
    }
    break;
  }
  const runner = words[i] ?? "";
  if (!RUNNERS.has(runner)) return false;
  if (isVerifyWord(runner)) return true; // bare vitest / jest / tsc / eslint …
  return words
    .slice(i + 1)
    .filter((word) => !word.startsWith("-"))
    .some(isVerifyWord);
}

/** Source-file extensions whose edits count as code mutations. */
const CODE_EXT_RE =
  /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|swift|c|h|cpp|cc|hpp|cs|php|vue|svelte|scala|sh|sql|m|mm|zig|ex|exs|erl|dart|lua|pl|r|jl|hs|clj)$/;

/** True for paths that look like source code (not docs, config or assets). */
export function isCodeFilePath(filePath: string): boolean {
  return CODE_EXT_RE.test(filePath);
}

export function buildVerificationFollowUpMessage(files: readonly string[]): Message {
  return {
    role: "user",
    provenance: { source: "runtime", kind: "completion_gate", visibility: "hidden" },
    content:
      "Verification gate: you changed code in this run, but no test, typecheck, lint or build " +
      "command has completed since the last edit:\n" +
      files.map((filePath) => `- ${filePath}`).join("\n") +
      "\nRun the project's verification now (its test command, or the closest equivalent) and " +
      "address any failures. Do not describe the change as tested or working without having run it.",
  };
}

export function buildVerificationEscalationMessage(files: readonly string[]): Message {
  return {
    role: "user",
    provenance: { source: "runtime", kind: "completion_gate", visibility: "hidden" },
    content:
      `Verification is still outstanding after ${MAX_VERIFICATION_INJECTIONS} attempt(s); ` +
      "the gate will not prompt again. Give your final response now and state plainly which of " +
      "these changes went unverified and why, so the user can check them:\n" +
      files.map((filePath) => `- ${filePath}`).join("\n"),
  };
}

/**
 * Bookkeeping for "code was edited, nothing proved it since". Callers record
 * successful edit/write mutations on code files and completed foreground
 * verification commands, in occurrence order; the gate is owed whenever the
 * newest recorded event is a mutation.
 */
export class VerificationGate {
  private seq = 0;
  private lastMutationSeq = 0;
  private lastVerificationSeq = 0;
  private injections = 0;
  /** Code files mutated since the last verification — the gate's file list. */
  private mutatedFiles = new Set<string>();

  recordMutation(filePath: string): void {
    this.lastMutationSeq = ++this.seq;
    this.mutatedFiles.add(filePath);
  }

  recordVerification(): void {
    this.lastVerificationSeq = ++this.seq;
    this.mutatedFiles.clear();
  }

  isOwed(): boolean {
    return this.lastMutationSeq > this.lastVerificationSeq;
  }

  /**
   * The blocking message for the pre-stop hook, or null when nothing is owed
   * or the injection budget is spent. First the demand (budget 1), then one
   * terminal escalation requiring an honest unverified statement, then silent.
   */
  followUp(): Message[] | null {
    if (!this.isOwed()) return null;
    if (this.injections >= MAX_VERIFICATION_INJECTIONS + 1) return null;
    this.injections += 1;
    const files = [...this.mutatedFiles].sort();
    return [
      this.injections > MAX_VERIFICATION_INJECTIONS
        ? buildVerificationEscalationMessage(files)
        : buildVerificationFollowUpMessage(files),
    ];
  }

  reset(): void {
    this.seq = 0;
    this.lastMutationSeq = 0;
    this.lastVerificationSeq = 0;
    this.injections = 0;
    this.mutatedFiles.clear();
  }
}
