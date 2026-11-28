// The exact code a cloud task starts from, as a one-commit git bundle.
//
// A validation snapshot is a new root commit whose tree IS the tested commit's
// tree (git commit-tree <sha>^{tree}), so the upload carries no history and
// the sandbox can prove it has exactly that code by comparing tree hashes. An
// agent snapshot adds the uncommitted work (tracked edits and untracked,
// not-ignored files) on top of HEAD, built in a private index so the user's
// index is never touched.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git, runGit } from "./git.js";
import { CloudError } from "./types.js";

/** Claude Code's upload cap for a seed bundle. */
export const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;

/** Files never sent to a cloud sandbox from an uncommitted working tree. */
const SECRET_NAME =
  /(^|\/)(\.env(\..*)?|.*\.tfvars|id_rsa|id_ed25519|id_ecdsa|.*\.pem|.*\.p12|.*\.pfx|.*\.key|\.npmrc|\.netrc|credentials(\.json)?)$/i;

export function isSecretLikePath(file: string): boolean {
  return SECRET_NAME.test(file.replace(/\\/g, "/"));
}

const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: "EZ Coder",
  GIT_AUTHOR_EMAIL: "ezcoder@localhost",
  GIT_COMMITTER_NAME: "EZ Coder",
  GIT_COMMITTER_EMAIL: "ezcoder@localhost",
  // Stable hashes for the same tree: tests and retries reuse one commit.
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

export interface Snapshot {
  /** Tree hash the sandbox must reproduce. */
  tree: string;
  /** Local root commit with that tree (kept in the local object store). */
  commit: string;
  /** Files left out because they look like credentials (agent snapshots). */
  withheld: string[];
}

/** Root commit whose tree is `tree`. */
async function rootCommit(repoRoot: string, tree: string, message: string): Promise<string> {
  return (
    await git(repoRoot, ["commit-tree", tree, "-m", message], {
      env: { ...process.env, ...AUTHOR_ENV },
    })
  ).trim();
}

/** Snapshot of exactly commit `sha` (validation). */
export async function commitSnapshot(repoRoot: string, sha: string): Promise<Snapshot> {
  const tree = (await git(repoRoot, ["rev-parse", `${sha}^{tree}`])).trim();
  const commit = await rootCommit(repoRoot, tree, `ez snapshot ${sha}`);
  return { tree, commit, withheld: [] };
}

/**
 * Snapshot of HEAD plus uncommitted work (agents). Credential-like files that
 * are not committed keep their committed version (or stay out).
 */
export async function workingTreeSnapshot(repoRoot: string): Promise<Snapshot> {
  const head = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ez-cloud-snap-"));
  try {
    const index = path.join(tmp, "index");
    const env = { ...process.env, GIT_INDEX_FILE: index };
    await git(repoRoot, ["read-tree", head], { env });
    await git(repoRoot, ["add", "-A"], { env });
    const changed = (await git(repoRoot, ["diff", "--cached", "--name-only", "-z", head], { env }))
      .split("\0")
      .filter(Boolean);
    const withheld = changed.filter(isSecretLikePath);
    for (const file of withheld) {
      // Back to the committed version, or out of the index when it is new.
      const inHead = await runGit(repoRoot, ["cat-file", "-e", `${head}:${file}`]);
      if (inHead.code === 0) await git(repoRoot, ["reset", "-q", head, "--", file], { env });
      else await git(repoRoot, ["rm", "-q", "--cached", "--", file], { env });
    }
    const tree = (await git(repoRoot, ["write-tree"], { env })).trim();
    const commit = await rootCommit(repoRoot, tree, `ez snapshot of ${head} with local changes`);
    return { tree, commit, withheld };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/**
 * A bundle holding just `commit` as branch `main` with HEAD on it (a seed
 * bundle needs a HEAD to check out). Throws too_large past the upload cap.
 */
export async function bundleOf(repoRoot: string, commit: string): Promise<Buffer> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ez-cloud-bundle-"));
  try {
    const bare = path.join(tmp, "repo.git");
    await git(tmp, ["init", "-q", "--bare", bare]);
    await git(bare, ["fetch", "-q", "--no-tags", repoRoot, `${commit}:refs/heads/main`]);
    await git(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    const file = path.join(tmp, "snapshot.bundle");
    await git(bare, ["bundle", "create", file, "HEAD", "main"]);
    const data = await fs.readFile(file);
    if (data.length > MAX_BUNDLE_BYTES) {
      throw new CloudError(
        `The code is ${Math.round(data.length / 1e6)} MB packed, over the cloud upload limit of ` +
          `${MAX_BUNDLE_BYTES / 1e6} MB.`,
        "too_large",
      );
    }
    return data;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
