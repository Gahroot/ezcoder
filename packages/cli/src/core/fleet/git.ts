// Where a fleet job's code comes from: the origin remote at an exact pushed
// commit, plus (on request) a binary patch of local work against the newest
// pushed ancestor. The user's index is never touched: untracked files are
// staged into a throwaway index copy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGitHubRepo } from "../validation/config.js";
import type { Exec } from "../validation/types.js";

/** Nodes accept patches up to 50 MB (base64). */
export const MAX_PATCH_BYTES = 50 * 1024 * 1024;

/**
 * A git remote URL without embedded credentials (X7). `https://user:token@host/x`
 * becomes `https://host/x`: nodes clone with their own credentials, and the URL
 * goes into job state, logs and containers. ssh usernames (`git@host:o/r`,
 * `ssh://git@host/o/r`) are kept; only an ssh password is dropped.
 */
export function stripUrlCredentials(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*@)?(.*)$/i.exec(url.trim());
  if (!m) return url.trim();
  const scheme = m[1]!;
  const userinfo = m[2];
  if (!userinfo) return url.trim();
  if (/^ssh$|^git\+ssh$|^ssh\+git$/i.test(scheme)) {
    const user = userinfo.slice(0, -1).split(":")[0]!;
    return `${scheme}://${user ? `${user}@` : ""}${m[3]}`;
  }
  return `${scheme}://${m[3]}`;
}

export interface SourceState {
  git: string;
  sha: string;
  branch?: string;
  /** owner/name for GitHub remotes. */
  repo?: string;
  /** Work tree has uncommitted changes (incl. untracked files). */
  dirty: boolean;
  /** The sha is known to be on the remote. */
  onRemote: boolean;
}

export interface PatchState {
  base: string;
  /** base64 binary patch; "" when nothing differs from base. */
  patch: string;
  files: number;
}

export class FleetGit {
  constructor(private readonly exec: Exec) {}

  async run(
    cwd: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<string | undefined> {
    const r = await this.exec("git", args, { cwd, timeoutMs: 60_000, ...(env ? { env } : {}) });
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  async state(cwd: string, ref = "HEAD"): Promise<SourceState> {
    const sha = await this.run(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
    if (!sha)
      throw new Error(`"${ref}" is not a commit in ${cwd} (is this a Git repo with commits?)`);
    const rawGit = await this.run(cwd, ["remote", "get-url", "origin"]);
    const git = rawGit ? stripUrlCredentials(rawGit) : undefined;
    if (!git) {
      throw new Error(
        "this repo has no `origin` remote; nodes clone the code from it (add one and push first)",
      );
    }
    const branchRaw = await this.run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = await this.run(cwd, ["status", "--porcelain"]);
    const repo = parseGitHubRepo(git);
    return {
      git,
      sha,
      ...(branchRaw && branchRaw !== "HEAD" ? { branch: branchRaw } : {}),
      ...(repo ? { repo } : {}),
      dirty: ref === "HEAD" && !!status,
      onRemote: await this.onRemote(cwd, sha, repo),
    };
  }

  /** Is the commit on origin? Remote-tracking branches first, then GitHub. */
  async onRemote(cwd: string, sha: string, repo?: string): Promise<boolean> {
    const contains = await this.run(cwd, ["branch", "-r", "--contains", sha]);
    if (contains) return true;
    const tags = await this.run(cwd, ["ls-remote", "--exit-code", "origin"]);
    if (tags?.split("\n").some((l) => l.startsWith(sha))) return true;
    if (repo) {
      const r = await this.exec("gh", ["api", `repos/${repo}/commits/${sha}`, "--jq", ".sha"], {
        timeoutMs: 30_000,
      });
      if (r.code === 0 && r.stdout.trim() === sha) return true;
    }
    return false;
  }

  /** Newest ancestor of `sha` that is on origin's remote-tracking branches. */
  async pushedBase(cwd: string, sha: string): Promise<string> {
    const local = await this.run(cwd, [
      "rev-list",
      "--topo-order",
      sha,
      "--not",
      "--remotes=origin",
    ]);
    if (local === undefined) throw new Error("could not read the commit history");
    if (!local) return sha;
    const oldest = local.split("\n").at(-1)!;
    const base = await this.run(cwd, ["rev-parse", "--verify", `${oldest}^`]);
    if (!base) throw new Error("no commit of this branch is on origin yet; push once first");
    return base;
  }

  /** Binary patch of the work tree (incl. untracked files) against the pushed base. */
  async patch(cwd: string, sha: string): Promise<PatchState> {
    const base = await this.pushedBase(cwd, sha);
    const gitIndex = await this.run(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    ]);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ezf-index-"));
    const tmpIndex = path.join(tmpDir, "index");
    try {
      if (gitIndex && fs.existsSync(gitIndex)) fs.copyFileSync(gitIndex, tmpIndex);
      const env = { GIT_INDEX_FILE: tmpIndex };
      if ((await this.run(cwd, ["add", "-A"], env)) === undefined) {
        throw new Error("could not stage local changes into a temporary index");
      }
      const r = await this.exec("git", ["diff", "--binary", "--cached", base], {
        cwd,
        timeoutMs: 120_000,
        env,
      });
      if (r.code !== 0) throw new Error(`git diff failed: ${r.stderr.trim().slice(0, 200)}`);
      const files = await this.run(cwd, ["diff", "--cached", "--name-only", base], env);
      const patch = r.stdout ? Buffer.from(r.stdout, "utf8").toString("base64") : "";
      if (patch.length > MAX_PATCH_BYTES) {
        throw new Error(
          `local changes are ${Math.round(patch.length / 1e6)} MB as a patch (max 50); commit and push instead`,
        );
      }
      return { base, patch, files: files ? files.split("\n").length : 0 };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
