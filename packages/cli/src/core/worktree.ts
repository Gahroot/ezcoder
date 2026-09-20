import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getGitDirtyFileCount } from "../utils/git.js";

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const MAX_COLLISION_ATTEMPTS = 20;

/**
 * `readOnly` plumbing sets GIT_OPTIONAL_LOCKS=0 so a query never takes the
 * index lock and fights a concurrent git. The env is read per call, not
 * captured at module load, so a later process.env change is honoured.
 */
async function git(cwd: string, args: string[], readOnly = true): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    env: readOnly ? { ...process.env, GIT_OPTIONAL_LOCKS: "0" } : process.env,
  });
  return String(stdout);
}

/** Same as `git`, but a non-zero exit resolves to null instead of throwing. */
async function gitOrNull(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

export type GitLayout = {
  worktreeRoot: string;
  gitDir: string;
  /** True when `.git` is a real directory (the primary checkout), false for a linked worktree. */
  isMain: boolean;
};

/**
 * Walk up from `startDir` to the nearest `.git`. A `.git` directory means the
 * main worktree; a `.git` *file* (`gitdir: <path>`) means an already-linked
 * worktree. Returns null when no repository encloses `startDir`.
 */
export async function gitLayout(startDir: string): Promise<GitLayout | null> {
  let dir = path.resolve(startDir);
  for (;;) {
    const dotGit = path.join(dir, ".git");
    let stat;
    try {
      stat = await fs.stat(dotGit);
    } catch {
      stat = null;
    }
    if (stat?.isDirectory()) {
      return { worktreeRoot: dir, gitDir: dotGit, isMain: true };
    }
    if (stat?.isFile()) {
      const contents = await fs.readFile(dotGit, "utf-8");
      const match = /^gitdir:\s*(.+)$/m.exec(contents);
      const target = match?.[1]?.trim();
      if (target) {
        const resolved = path.isAbsolute(target) ? target : path.resolve(dir, target);
        return { worktreeRoot: dir, gitDir: path.normalize(resolved), isMain: false };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The enclosing repo's root, but only when `startDir` is inside the MAIN worktree. */
export async function findMainWorktreeRoot(startDir: string): Promise<string | null> {
  const layout = await gitLayout(startDir);
  return layout?.isMain ? layout.worktreeRoot : null;
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string | null;
  isBare: boolean;
  isMain: boolean;
}

/**
 * Parse `git worktree list --porcelain`. The first block is always the main
 * worktree. Paths are canonicalised so callers can compare them by string
 * equality (/var vs /private/var aliasing on macOS).
 */
export async function listWorktrees(repoDir: string): Promise<WorktreeEntry[]> {
  const stdout = await git(repoDir, ["worktree", "list", "--porcelain"]);
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = {
        path: line.slice("worktree ".length).trim(),
        branch: null,
        head: null,
        isBare: false,
        isMain: entries.length === 0,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length).trim();
    else if (line.startsWith("branch "))
      current.branch = line
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//, "");
    else if (line === "bare") current.isBare = true;
  }
  if (current) entries.push(current);

  for (const entry of entries) entry.path = await realpathOrSelf(entry.path);
  return entries;
}

/** True when `git status --porcelain` reports anything (tracked or untracked). */
export async function isWorkingTreeDirty(dir: string): Promise<boolean> {
  return (await getGitDirtyFileCount(dir)) > 0;
}

/**
 * Normalise arbitrary text into a branch name git will accept. Returns "" when
 * nothing usable survives, so callers can fall back to a generated name.
 */
export function slugifyBranch(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9._/-]+/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-./]+/, "")
    .replace(/[-./]+$/, "");

  if (!slug) return "";
  if (slug.includes("..")) return "";
  if (slug.endsWith(".lock") || slug.split("/").some((part) => part.endsWith(".lock"))) return "";
  if (slug.startsWith("-")) return "";
  return slug;
}

/** Pure: `<home>/.ezcoder/worktrees/<basename(repoRoot)>`. */
export function worktreesRootFor(repoRoot: string, homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".ezcoder", "worktrees", path.basename(path.resolve(repoRoot)));
}

export interface CreateWorktreeOptions {
  repoDir: string;
  branch?: string;
  baseRef?: string;
  allowDirty?: boolean;
}

/**
 * Name of the file, inside a linked worktree's own git dir, recording the ref it
 * was forked from.
 *
 * Reclaim has to answer "does this branch hold commits nobody else has", and
 * that question is only meaningful against the ref the worktree ACTUALLY forked
 * from. Comparing against whatever `main` points at today gets it wrong in both
 * directions: main moving ahead makes an untouched worktree look behind, and a
 * worktree forked from a feature branch looks full of "new" commits that its
 * base already contains. Git does not record the fork point anywhere durable
 * (reflogs expire, and a rebased base breaks merge-base), so it is written at
 * creation time and read back verbatim.
 */
const BASE_REF_FILE = "ezcoder-base";

export interface CreatedWorktree {
  path: string;
  branch: string;
  baseRef: string;
  created: true;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function branchExists(repoDir: string, branch: string): Promise<boolean> {
  const sha = await gitOrNull(repoDir, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  return Boolean(sha?.trim());
}

/** Resolve the MAIN worktree root for any directory inside a repo (linked or not). */
async function resolveMainRoot(repoDir: string): Promise<string> {
  const layout = await gitLayout(repoDir);
  if (!layout) throw new Error(`Not a git repository: ${repoDir}`);
  if (layout.isMain) return layout.worktreeRoot;

  // Linked worktree: the common dir is the main checkout's .git, whose parent
  // is the main worktree root.
  const commonDir = (await gitOrNull(repoDir, ["rev-parse", "--git-common-dir"]))?.trim();
  const resolved = commonDir
    ? path.resolve(repoDir, commonDir)
    : // .git/worktrees/<name> → .git
      path.dirname(path.dirname(layout.gitDir));
  return path.dirname(resolved);
}

/**
 * Create a linked worktree on a fresh branch under `worktreesRootFor(mainRoot)`.
 * Refuses to run against a dirty main checkout unless `allowDirty` is set — a
 * half-committed main tree is the fastest way to lose work across worktrees.
 */
export async function createWorktree(opts: CreateWorktreeOptions): Promise<CreatedWorktree> {
  const mainRoot = await resolveMainRoot(opts.repoDir);

  let baseRef = opts.baseRef?.trim();
  if (!baseRef) {
    const head = (await gitOrNull(mainRoot, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim();
    if (!head) throw new Error(`Cannot determine HEAD of ${mainRoot} (no commits yet?)`);
    baseRef =
      head === "HEAD" ? ((await gitOrNull(mainRoot, ["rev-parse", "HEAD"]))?.trim() ?? head) : head;
  }

  if (!opts.allowDirty && (await isWorkingTreeDirty(mainRoot))) {
    throw new Error(
      `The main checkout at ${mainRoot} has uncommitted changes; no worktree was created. ` +
        `Commit or stash them first, or pass allowDirty to create the worktree anyway.`,
    );
  }

  const requested = opts.branch ? slugifyBranch(opts.branch) : "";
  const base = requested || `ez/${Date.now().toString(36)}`;
  const worktreesRoot = worktreesRootFor(mainRoot);
  await fs.mkdir(worktreesRoot, { recursive: true });

  for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt++) {
    const branch = attempt === 1 ? base : `${base}-${attempt}`;
    const targetPath = path.join(worktreesRoot, branch.replace(/\//g, "-"));
    if ((await branchExists(mainRoot, branch)) || (await pathExists(targetPath))) continue;

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await git(mainRoot, ["worktree", "add", "-b", branch, targetPath, baseRef], false);
    await writeBaseRef(targetPath, baseRef);
    return { path: await realpathOrSelf(targetPath), branch, baseRef, created: true };
  }

  throw new Error(
    `Could not find a free worktree branch name for "${base}" after ${MAX_COLLISION_ATTEMPTS} attempts.`,
  );
}

/**
 * Record the fork point inside the new worktree's own git dir (not its working
 * tree): the working tree belongs to the user and an agent, and a stray file
 * there would show up as an untracked change, which would in turn make the
 * worktree permanently "dirty" and therefore never reclaimable.
 *
 * Best effort. A worktree with no base file still reclaims — `readBaseRef`
 * falls back — so a write failure must not fail the creation that succeeded.
 */
async function writeBaseRef(worktreePath: string, baseRef: string): Promise<void> {
  try {
    const layout = await gitLayout(worktreePath);
    if (!layout) return;
    await fs.writeFile(path.join(layout.gitDir, BASE_REF_FILE), `${baseRef}\n`, "utf-8");
  } catch {
    // Non-fatal: see doc comment.
  }
}

/**
 * The ref this worktree forked from, or null when unrecorded (a worktree made
 * before this file existed, or by hand with plain git).
 */
async function readBaseRef(worktreePath: string): Promise<string | null> {
  try {
    const layout = await gitLayout(worktreePath);
    if (!layout) return null;
    const raw = await fs.readFile(path.join(layout.gitDir, BASE_REF_FILE), "utf-8");
    return raw.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Pure: is `candidate` inside `root`?
 *
 * `path.relative` rather than `startsWith`: the string form says yes to
 * `/a/worktrees-evil` for root `/a/worktrees`, and on Windows says no to a
 * correct path that differs only in separator or drive-letter case. An empty
 * relative path (candidate IS root) is deliberately NOT contained — removing
 * the container itself is never what a caller means.
 */
export function isInsideWorktreesRoot(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (!rel) return false;
  if (rel.startsWith("..")) return false;
  return !path.isAbsolute(rel);
}

/**
 * The first symlink at or above `dir` (stopping at the filesystem root), or
 * null when the whole chain is real directories.
 *
 * A containment check alone cannot see this: `stat` dereferences every path
 * component, so a symlink at `~/.ezcoder/worktrees` makes every path under it
 * look like an ordinary contained directory while the removal lands in whatever
 * checkout it points at — the user's real repo, most likely. `lstat` sees the
 * link itself. Every destructive path routes through here.
 */
export async function redirectedAncestor(dir: string): Promise<string | null> {
  let current = path.resolve(dir);
  for (;;) {
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) return current;
    } catch {
      // Missing components cannot redirect anything.
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export interface WorktreeStatus {
  path: string;
  branch: string | null;
  /** Ref it forked from; null when unrecorded and no fallback resolved. */
  baseRef: string | null;
  /** Staged, modified and untracked files. Non-zero means unsaved work. */
  dirtyFiles: number;
  /** Commits on `branch` that `baseRef` does not contain. */
  commitsAhead: number;
  /** The branch is fully contained in `baseRef`. */
  merged: boolean;
  /** Another window is working here, so it must not be touched. */
  busy: boolean;
  /** Safe to remove with nothing lost. */
  reclaimable: boolean;
  /** Why not, in the user's words. Empty exactly when `reclaimable`. */
  blockedBy: string[];
}

/** Count commits on `branch` absent from `baseRef`; null when git cannot say. */
async function commitsAhead(dir: string, baseRef: string, branch: string): Promise<number | null> {
  // `--` guards a ref whose name could otherwise be read as a path.
  const out = await gitOrNull(dir, ["rev-list", "--count", `${baseRef}..${branch}`, "--"]);
  if (out === null) return null;
  const n = Number.parseInt(out.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Describe one worktree well enough to decide its fate, from the worktree's own
 * directory so a stale main-checkout view cannot mislead.
 *
 * Unknowns always count AGAINST reclaiming: a git call that fails leaves the
 * entry blocked rather than deleted. The cost of a wrong "keep" is a stale
 * folder; the cost of a wrong "delete" is lost work.
 */
export async function worktreeStatus(
  mainRoot: string,
  entry: WorktreeEntry,
  busyPaths: readonly string[] = [],
): Promise<WorktreeStatus> {
  const blockedBy: string[] = [];

  const busySet = new Set(await Promise.all(busyPaths.map((p) => realpathOrSelf(p))));
  const busy = busySet.has(await realpathOrSelf(entry.path));
  if (busy) blockedBy.push("it is open in another window");

  // -1 marks "could not read", which blocks just as a dirty tree does: an
  // unreadable status is never evidence that a copy is empty.
  const dirtyFiles = await getGitDirtyFileCount(entry.path).catch(() => -1);
  if (dirtyFiles > 0) blockedBy.push(`it has ${dirtyFiles} uncommitted file(s)`);
  else if (dirtyFiles < 0) blockedBy.push("its status could not be read");

  const baseRef = (await readBaseRef(entry.path)) ?? (await defaultBaseRef(mainRoot));
  let ahead: number | null = null;
  if (baseRef && entry.branch) {
    ahead = await commitsAhead(entry.path, baseRef, entry.branch);
    if (ahead === null) blockedBy.push("its commits could not be compared to the base branch");
    else if (ahead > 0) blockedBy.push(`it has ${ahead} unmerged commit(s)`);
  } else {
    blockedBy.push("its base branch is unknown");
  }

  if (!isInsideWorktreesRoot(worktreesRootFor(mainRoot), entry.path)) {
    blockedBy.push("it lives outside the managed copies folder");
  }
  if (entry.isMain) blockedBy.push("it is the main checkout");

  return {
    path: entry.path,
    branch: entry.branch,
    baseRef,
    dirtyFiles: Math.max(dirtyFiles, 0),
    commitsAhead: ahead ?? 0,
    merged: ahead === 0,
    busy,
    reclaimable: blockedBy.length === 0,
    blockedBy,
  };
}

/** The main checkout's current branch, used when no fork point was recorded. */
async function defaultBaseRef(mainRoot: string): Promise<string | null> {
  const head = (await gitOrNull(mainRoot, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim();
  return head && head !== "HEAD" ? head : null;
}

/** Status for every linked worktree of `repoDir`'s repo, main checkout excluded. */
export async function worktreeStatuses(
  repoDir: string,
  busyPaths: readonly string[] = [],
): Promise<WorktreeStatus[]> {
  const mainRoot = await resolveMainRoot(repoDir);
  const entries = await listWorktrees(mainRoot);
  return await Promise.all(
    entries.filter((e) => !e.isMain).map((e) => worktreeStatus(mainRoot, e, busyPaths)),
  );
}

/** Worktrees that can be removed right now with nothing lost. */
export async function reclaimableWorktrees(
  repoDir: string,
  busyPaths: readonly string[] = [],
): Promise<WorktreeStatus[]> {
  return (await worktreeStatuses(repoDir, busyPaths)).filter((s) => s.reclaimable);
}

export interface WorktreeRelease {
  /** Something was at the path when the release started. */
  existed: boolean;
  /** The path is free now — a `worktree add` over it would succeed. */
  freed: boolean;
  /** The branch is gone too. */
  branchDeleted: boolean;
  /** Why it is not free. Set exactly when `existed && !freed`. */
  reason?: string;
}

/**
 * Free a worktree's path AND its branch. Never throws: cleanup runs on window
 * close and on daemon startup, where an exception would surface as a crash in
 * an unrelated flow. Everything it could not do comes back in the result.
 *
 * The order below is load-bearing and `prune` is not optional. `worktree
 * remove` needs the directory to be there; a user reclaiming disk with
 * `rm -rf ~/.ezcoder/worktrees` leaves the tree REGISTERED BUT MISSING, and git
 * then refuses both of the things the next run needs:
 *
 *     $ git worktree add <path> <branch>
 *     fatal: '<path>' is a missing but already registered worktree;
 *     use 'add -f' to override, or 'prune' or 'remove' to clear
 *
 * and `git branch -d <branch>`, because the branch counts as checked out in
 * that phantom. `git worktree prune` is the only thing that clears the
 * registration, and it is a no-op when nothing is stale — so it runs
 * unconditionally, and BEFORE the branch delete that depends on it.
 */
export async function removeWorktree(opts: {
  repoDir: string;
  worktreePath: string;
  /** Remove even with uncommitted or unmerged work. Caller must have confirmed. */
  force?: boolean;
  /** Delete the branch too. Default true. */
  deleteBranch?: boolean;
}): Promise<WorktreeRelease> {
  let mainRoot: string;
  try {
    mainRoot = await resolveMainRoot(opts.repoDir);
  } catch (err) {
    return { existed: false, freed: false, branchDeleted: false, reason: messageOf(err) };
  }

  const target = path.resolve(opts.worktreePath);
  const root = worktreesRootFor(mainRoot);

  // Containment BEFORE anything destructive. The path arrives over HTTP from
  // the app; a request naming a path is not authorization to delete it.
  if (!isInsideWorktreesRoot(root, target)) {
    return {
      existed: true,
      freed: false,
      branchDeleted: false,
      reason: `refusing to remove ${target}: it is outside ${root}`,
    };
  }

  // A symlink ANYWHERE above the target redirects both the git remove and the
  // rm fallback into whatever it points at, while the containment check above
  // still reads as contained. `dirname`, because a link AT the target is
  // unlinked below rather than followed.
  try {
    const redirected = await redirectedAncestor(path.dirname(target));
    if (redirected !== null) {
      return {
        existed: true,
        freed: false,
        branchDeleted: false,
        reason: `refusing to remove through a symlink: ${redirected} is a link, so the removal would land wherever it points`,
      };
    }
  } catch (err) {
    return { existed: true, freed: false, branchDeleted: false, reason: messageOf(err) };
  }

  const existed = await pathExists(target);
  // Read the branch BEFORE the removal: afterwards the registration is gone and
  // there is nothing left to ask.
  const registeredBranch = await branchAtPath(mainRoot, target);
  const branch = opts.deleteBranch === false ? null : registeredBranch;
  const isRegistered = registeredBranch !== null;

  let removeError: unknown;
  if (existed) {
    // `--force` only when the caller actually asked for it. Without it git
    // refuses to remove a worktree holding uncommitted work, which is a second
    // safety net under the `reclaimable` check the sweep already did.
    const args = opts.force
      ? ["worktree", "remove", "--force", target]
      : ["worktree", "remove", target];
    try {
      await git(mainRoot, args, false);
    } catch (err) {
      removeError = err;
      // Fall back to a direct delete ONLY when nothing would be lost by it:
      // either the caller forced, or the path is not a registered worktree at
      // all (a leftover directory git has already forgotten). A non-forced
      // refusal over a REGISTERED tree is git protecting real work, and
      // deleting it here would turn that protection into data loss.
      if (opts.force || !isRegistered) {
        try {
          await fs.rm(target, { recursive: true, force: true });
          removeError = undefined;
        } catch (rmErr) {
          removeError = rmErr;
        }
      }
    }
  }

  // Always, even when nothing existed: this is what clears a registration whose
  // directory someone deleted by hand, and it must precede the branch delete.
  const pruned = (await gitOrNull(mainRoot, ["worktree", "prune"])) !== null;

  const stillThere = await pathExists(target);
  if (existed && stillThere) {
    return {
      existed,
      freed: false,
      branchDeleted: false,
      reason: removeError
        ? messageOf(removeError)
        : "the path is still there after `git worktree remove --force` and a direct delete",
    };
  }
  if (!pruned) {
    return {
      existed,
      freed: false,
      branchDeleted: false,
      reason:
        "`git worktree prune` could not run, so the registration and the branch survive; " +
        "the next copy over this path would fail with \u201cmissing but already registered\u201d",
    };
  }

  let branchDeleted = false;
  if (branch) {
    // -D rather than -d when forcing: an unmerged branch whose removal the user
    // confirmed must not survive as a dangling ref.
    const flag = opts.force ? "-D" : "-d";
    branchDeleted = (await gitOrNull(mainRoot, ["branch", flag, "--", branch])) !== null;
  }

  return { existed, freed: true, branchDeleted };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The branch checked out at `target`, read from the worktree itself. */
async function branchAtPath(mainRoot: string, target: string): Promise<string | null> {
  const entries = await listWorktrees(mainRoot).catch(() => [] as WorktreeEntry[]);
  for (const entry of entries) {
    if ((await realpathOrSelf(entry.path)) === (await realpathOrSelf(target))) return entry.branch;
  }
  return null;
}

export interface SweepResult {
  removed: WorktreeStatus[];
  kept: { status: WorktreeStatus; reason: string }[];
}

/**
 * Remove every worktree of `repoDir`'s repo that is provably free of work.
 *
 * The automatic entry point: window close and daemon startup. It never forces,
 * so anything holding uncommitted or unmerged work is reported as kept, with
 * the reason, and waits for a human. Failures are collected rather than thrown
 * — one wedged worktree must not stop the rest of the sweep.
 */
export async function sweepWorktrees(
  repoDir: string,
  busyPaths: readonly string[] = [],
): Promise<SweepResult> {
  const result: SweepResult = { removed: [], kept: [] };
  let statuses: WorktreeStatus[];
  try {
    statuses = await worktreeStatuses(repoDir, busyPaths);
  } catch {
    return result;
  }

  for (const status of statuses) {
    if (!status.reclaimable) {
      result.kept.push({ status, reason: status.blockedBy.join("; ") });
      continue;
    }
    const release = await removeWorktree({
      repoDir,
      worktreePath: status.path,
      force: false,
      deleteBranch: true,
    });
    if (release.freed) result.removed.push(status);
    else result.kept.push({ status, reason: release.reason ?? "it could not be removed" });
  }
  return result;
}

/** True when the repo already has at least one linked worktree registered. */
export async function repoHasLinkedWorktrees(mainRoot: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(path.join(mainRoot, ".git", "worktrees"));
    return entries.some((name) => !name.startsWith("."));
  } catch {
    return false;
  }
}
