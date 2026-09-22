import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { log } from "./logger.js";

const exec = promisify(execFile);

/**
 * Make a fresh worktree usable, not merely present.
 *
 * `git worktree add` checks out TRACKED files only, so a new copy is missing
 * exactly the things a repo deliberately keeps out of git: `.env`, registry
 * credentials, installed packages. The copy looks fine and then nothing runs in
 * it — which, for an agent working unattended in that copy, reads as a broken
 * project rather than a missing setup step.
 *
 * Two steps close that gap: carry a small allowlist of ignored CONFIG files
 * across, then run the project's own install command.
 */

/** Cap on a carried file. Config is tiny; anything larger is data, not config. */
const CARRY_MAX_BYTES = 64 * 1024;

/**
 * Basenames worth carrying, matched against ignored files only.
 *
 * Deliberately an allowlist. The inverse — "copy every ignored file under some
 * size" — sweeps up local databases, key material, scratch notes and editor
 * state, and silently multiplies copies of whatever secret happens to sit in
 * the repo. These are the files whose ABSENCE breaks a build:
 *   - `.env` and friends: the app's own configuration.
 *   - `.npmrc` / `.yarnrc`: private-registry auth, needed BY the install below,
 *     which is why the carry runs first.
 */
const CARRY_PATTERNS: readonly RegExp[] = [
  /^\.env($|\.)/i, // .env, .env.local, .env.development…
  /\.env$/i, // local.env, test.env…
  /^\.npmrc$/i,
  /^\.yarnrc(\.yml)?$/i,
];

function isCarryable(basename: string): boolean {
  return CARRY_PATTERNS.some((re) => re.test(basename));
}

/**
 * Pure: is `candidate` inside `root`? Same reasoning as the worktree module's
 * containment check — `path.relative`, never `startsWith`.
 */
function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Ignored files git knows about, as repo-relative paths.
 *
 * `--directory` collapses a wholly-ignored directory to a single `dir/` entry
 * instead of listing its contents, which is what keeps `node_modules` from
 * arriving here as 40,000 paths. Entries ending in `/` are those directories
 * and are dropped: package trees get installed below, not copied.
 */
async function listIgnoredFiles(mainRoot: string): Promise<string[]> {
  const { stdout } = await exec(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    {
      cwd: mainRoot,
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  return stdout.split("\0").filter((entry) => entry && !entry.endsWith("/"));
}

/**
 * Copy allowlisted ignored config from the main checkout into a fresh worktree.
 * Returns the repo-relative paths actually copied.
 *
 * Never throws: a worktree that exists but lacks its `.env` is still a worktree,
 * and failing the creation over a copy would be a worse outcome than reporting
 * what is missing.
 */
export async function carryIgnoredConfig(
  mainRoot: string,
  worktreePath: string,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await listIgnoredFiles(mainRoot);
  } catch (err) {
    log("INFO", "worktree-setup", "could not list ignored files", { message: messageOf(err) });
    return [];
  }

  const carried: string[] = [];
  for (const rel of entries) {
    if (!isCarryable(path.basename(rel))) continue;

    // git reports paths relative to the repo root, but a path arriving from a
    // subprocess is still input: a `..` segment or an absolute entry must not
    // be able to read outside the checkout or write outside the worktree.
    const from = path.resolve(mainRoot, rel);
    const to = path.resolve(worktreePath, rel);
    if (!isInside(mainRoot, from) || !isInside(worktreePath, to)) continue;

    try {
      // lstat, not stat: a symlink is followed by copyFile, so a link pointing
      // at /etc/passwd or a 2GB file would be copied as its target. Only real,
      // small, regular files qualify.
      const stat = await fs.lstat(from);
      if (!stat.isFile() || stat.size > CARRY_MAX_BYTES) continue;

      await fs.mkdir(path.dirname(to), { recursive: true });
      // COPYFILE_EXCL: never clobber a file the checkout already produced.
      await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      carried.push(rel);
    } catch (err) {
      log("INFO", "worktree-setup", "could not carry file", { rel, message: messageOf(err) });
    }
  }
  return carried;
}

export interface InstallCommand {
  command: string;
  args: string[];
}

/** Human-readable form, for logs and for telling the user what ran. */
export function formatCommand(cmd: InstallCommand): string {
  return [cmd.command, ...cmd.args].join(" ");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The install command(s) this project uses, chosen by lockfile.
 *
 * Lockfile over `packageManager` field or heuristics: the lockfile is what the
 * project actually installs with, and picking the wrong package manager in a
 * copy produces a second lockfile as an unexplained diff.
 *
 * `install` rather than `ci`/`--frozen-lockfile`: this is a private copy of a
 * tree the user is mid-edit on, where a lockfile that no longer matches
 * `package.json` is normal. A frozen install would hard-fail on exactly that.
 */
export async function detectInstallCommands(dir: string): Promise<InstallCommand[]> {
  const cmds: InstallCommand[] = [];
  const has = (name: string): Promise<boolean> => exists(path.join(dir, name));

  if (await has("pnpm-lock.yaml")) cmds.push({ command: "pnpm", args: ["install"] });
  else if (await has("yarn.lock")) cmds.push({ command: "yarn", args: ["install"] });
  else if ((await has("bun.lockb")) || (await has("bun.lock")))
    cmds.push({ command: "bun", args: ["install"] });
  else if ((await has("package-lock.json")) || (await has("package.json")))
    cmds.push({ command: "npm", args: ["install"] });

  // Python projects whose environment lives in an ignored directory have the
  // same problem as node_modules. Cargo and Go are absent on purpose: they
  // fetch on first build, so there is nothing useful to pre-run.
  if (await has("uv.lock")) cmds.push({ command: "uv", args: ["sync"] });
  else if (await has("poetry.lock")) cmds.push({ command: "poetry", args: ["install"] });

  return cmds;
}

export interface InstallResult {
  command: string;
  ok: boolean;
  /** Why it failed, trimmed to the tail that names the cause. Set when !ok. */
  message?: string;
}

/** Last `limit` characters of the output that actually says what went wrong. */
function tail(text: string, limit = 600): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run one install in `dir`. Argument array, never a shell string: the command
 * is chosen from a fixed table above, and keeping it unparsed means a repo path
 * containing shell metacharacters stays a path.
 */
async function runInstall(
  dir: string,
  cmd: InstallCommand,
  timeoutMs: number,
): Promise<InstallResult> {
  const label = formatCommand(cmd);
  try {
    await exec(cmd.command, cmd.args, {
      cwd: dir,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      // Inherit the enriched PATH the sidecar builds at startup, otherwise a
      // GUI-launched app cannot find pnpm/uv at all.
      env: process.env,
    });
    return { command: label, ok: true };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const stdout = (err as { stdout?: string }).stdout ?? "";
    const killed = (err as { killed?: boolean }).killed === true;
    const detail = killed
      ? `it did not finish within ${Math.round(timeoutMs / 1000)}s`
      : tail(stderr || stdout || messageOf(err));
    return { command: label, ok: false, message: detail };
  }
}

export interface WorktreePreparation {
  /** Repo-relative ignored config files copied into the copy. */
  carried: string[];
  /** One entry per install command attempted, in order. */
  installs: InstallResult[];
  /** Everything attempted succeeded. False when any install failed. */
  ok: boolean;
}

export interface PrepareWorktreeOptions {
  mainRoot: string;
  worktreePath: string;
  /** Skip the install step (carry only). */
  skipInstall?: boolean;
  /** Per-command cap. Default 10 minutes — a cold monorepo install is slow. */
  timeoutMs?: number;
}

/**
 * Carry ignored config, then install dependencies, so the new copy can build
 * and test without the user setting it up by hand.
 *
 * Never throws and never undoes the worktree: a copy with a failed install is
 * still a copy the user can fix, and reporting the failure beats destroying the
 * branch it sits on. Callers surface `installs[].message` rather than treating
 * it as an error.
 */
export async function prepareWorktree(opts: PrepareWorktreeOptions): Promise<WorktreePreparation> {
  const { mainRoot, worktreePath } = opts;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;

  const carried = await carryIgnoredConfig(mainRoot, worktreePath);
  if (opts.skipInstall) return { carried, installs: [], ok: true };

  const installs: InstallResult[] = [];
  for (const cmd of await detectInstallCommands(worktreePath)) {
    const result = await runInstall(worktreePath, cmd, timeoutMs);
    installs.push(result);
    // Stop at the first failure: a later command in the same copy will almost
    // always fail for the same reason, and one clear message beats three.
    if (!result.ok) break;
  }

  const ok = installs.every((r) => r.ok);
  log(ok ? "INFO" : "WARN", "worktree-setup", "prepared worktree", {
    worktreePath,
    carried: carried.length,
    installs: installs.map((r) => `${r.command}${r.ok ? "" : " (failed)"}`),
  });
  return { carried, installs, ok };
}
