import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorktree,
  findMainWorktreeRoot,
  gitLayout,
  isInsideWorktreesRoot,
  isWorkingTreeDirty,
  listWorktrees,
  reclaimableWorktrees,
  redirectedAncestor,
  removeWorktree,
  repoHasLinkedWorktrees,
  slugifyBranch,
  sweepWorktrees,
  worktreeStatuses,
  worktreesRootFor,
} from "./worktree.js";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const d = hasGit() ? describe : describe.skip;

const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "t@t.t",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "t@t.t",
    },
  }).trim();
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

async function pathIsGone(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return false;
  } catch {
    return true;
  }
}

/** A real repo with one commit. */
async function makeRepo(): Promise<string> {
  const repo = await makeTempDir("ez-worktree-");
  git(repo, "init", "-q", "-b", "main");
  await fs.writeFile(path.join(repo, "a.txt"), "hello\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "initial");
  return repo;
}

d("worktree", () => {
  const realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

  // createWorktree writes under os.homedir(); point that at a temp dir so the
  // suite never touches the developer's real ~/.ezcoder/worktrees.
  beforeEach(async () => {
    const fakeHome = await makeTempDir("ez-worktree-home-");
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(realHome)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  describe("gitLayout / findMainWorktreeRoot", () => {
    it("reports the main worktree when .git is a directory", async () => {
      const repo = await makeRepo();
      const layout = await gitLayout(repo);
      expect(layout).not.toBeNull();
      expect(layout!.isMain).toBe(true);
      expect(layout!.worktreeRoot).toBe(repo);
      expect(layout!.gitDir).toBe(path.join(repo, ".git"));
      expect(await findMainWorktreeRoot(repo)).toBe(repo);
    });

    it("walks up from a nested directory", async () => {
      const repo = await makeRepo();
      const nested = path.join(repo, "src", "deep");
      await fs.mkdir(nested, { recursive: true });
      expect((await gitLayout(nested))!.worktreeRoot).toBe(repo);
    });

    it("reports a linked worktree when .git is a file", async () => {
      const repo = await makeRepo();
      const created = await createWorktree({ repoDir: repo, branch: "linked" });

      const layout = await gitLayout(created.path);
      expect(layout).not.toBeNull();
      expect(layout!.isMain).toBe(false);
      expect(layout!.worktreeRoot).toBe(created.path);
      expect(layout!.gitDir).toContain(path.join(".git", "worktrees", "linked"));
      expect(await findMainWorktreeRoot(created.path)).toBeNull();
    });

    it("returns null outside a repository", async () => {
      const plain = await makeTempDir("ez-worktree-plain-");
      expect(await gitLayout(plain)).toBeNull();
    });
  });

  describe("listWorktrees", () => {
    it("marks the first entry as main and parses the linked one", async () => {
      const repo = await makeRepo();
      expect(await repoHasLinkedWorktrees(repo)).toBe(false);
      const created = await createWorktree({ repoDir: repo, branch: "feature-x" });

      const list = await listWorktrees(repo);
      expect(list).toHaveLength(2);
      expect(list[0]).toMatchObject({ path: repo, branch: "main", isMain: true, isBare: false });
      expect(list[0].head).toMatch(/^[0-9a-f]{40}$/);
      expect(list[1]).toMatchObject({
        path: created.path,
        branch: "feature-x",
        isMain: false,
        isBare: false,
      });
      expect(await repoHasLinkedWorktrees(repo)).toBe(true);
    });
  });

  describe("isWorkingTreeDirty", () => {
    it("is false on a clean repo and true after an untracked file appears", async () => {
      const repo = await makeRepo();
      expect(await isWorkingTreeDirty(repo)).toBe(false);
      await fs.writeFile(path.join(repo, "untracked.txt"), "x\n");
      expect(await isWorkingTreeDirty(repo)).toBe(true);
    });
  });

  describe("slugifyBranch", () => {
    it("lowercases and dashes spaces and underscores", () => {
      expect(slugifyBranch("Add Login  Flow")).toBe("add-login-flow");
      expect(slugifyBranch("fix_some_BUG")).toBe("fix-some-bug");
    });

    it("keeps legal characters and strips illegal ones", () => {
      expect(slugifyBranch("feat/api.v2")).toBe("feat/api.v2");
      expect(slugifyBranch("wat?! ~is^ this:")).toBe("wat-is-this");
    });

    it("trims leading/trailing dashes, dots and slashes", () => {
      expect(slugifyBranch("--hello--")).toBe("hello");
      expect(slugifyBranch("/nested/")).toBe("nested");
    });

    it("rejects names git would refuse", () => {
      expect(slugifyBranch("a..b")).toBe("");
      expect(slugifyBranch("thing.lock")).toBe("");
      expect(slugifyBranch("feat/thing.lock")).toBe("");
      expect(slugifyBranch("")).toBe("");
      expect(slugifyBranch("???")).toBe("");
      expect(slugifyBranch("   ")).toBe("");
    });
  });

  describe("worktreesRootFor", () => {
    it("is pure and uses the explicit home dir", () => {
      expect(worktreesRootFor("/tmp/projects/my-repo", "/home/bee")).toBe(
        path.join("/home/bee", ".ezcoder", "worktrees", "my-repo"),
      );
      expect(worktreesRootFor("/tmp/projects/my-repo/", "/home/bee")).toBe(
        path.join("/home/bee", ".ezcoder", "worktrees", "my-repo"),
      );
    });
  });

  describe("createWorktree", () => {
    it("creates a real worktree on a new branch that shows up in listWorktrees", async () => {
      const repo = await makeRepo();
      const created = await createWorktree({ repoDir: repo, branch: "My Feature" });

      expect(created).toMatchObject({ branch: "my-feature", baseRef: "main", created: true });
      expect(await fs.readFile(path.join(created.path, "a.txt"), "utf-8")).toBe("hello\n");
      expect(git(created.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("my-feature");

      const list = await listWorktrees(repo);
      expect(list.map((e) => e.path)).toContain(created.path);
    });

    it("throws for a directory that is not a git repository", async () => {
      const plain = await makeTempDir("ez-worktree-plain-");
      await expect(createWorktree({ repoDir: plain })).rejects.toThrow(/not a git repository/i);
    });

    it("refuses a dirty main checkout unless allowDirty is set", async () => {
      const repo = await makeRepo();
      await fs.writeFile(path.join(repo, "dirty.txt"), "wip\n");

      await expect(createWorktree({ repoDir: repo, branch: "gated" })).rejects.toThrow(
        /uncommitted changes/i,
      );
      expect(await listWorktrees(repo)).toHaveLength(1);

      const created = await createWorktree({
        repoDir: repo,
        branch: "gated",
        allowDirty: true,
      });
      expect(created.branch).toBe("gated");
      expect(await listWorktrees(repo)).toHaveLength(2);
    });

    it("retries collisions with a -2 suffix", async () => {
      const repo = await makeRepo();
      const first = await createWorktree({ repoDir: repo, branch: "dup" });
      const second = await createWorktree({ repoDir: repo, branch: "dup" });

      expect(first.branch).toBe("dup");
      expect(second.branch).toBe("dup-2");
      expect(second.path).not.toBe(first.path);
      expect((await listWorktrees(repo)).map((e) => e.branch)).toEqual(["main", "dup", "dup-2"]);
    });

    it("honours an explicit baseRef and works from a linked worktree", async () => {
      const repo = await makeRepo();
      const sha = git(repo, "rev-parse", "HEAD");
      const linked = await createWorktree({ repoDir: repo, branch: "first" });

      const fromLinked = await createWorktree({
        repoDir: linked.path,
        branch: "second",
        baseRef: sha,
      });
      expect(fromLinked.baseRef).toBe(sha);
      expect(git(fromLinked.path, "rev-parse", "HEAD")).toBe(sha);
      expect((await listWorktrees(repo)).map((e) => e.branch)).toContain("second");
    });
  });

  describe("isInsideWorktreesRoot", () => {
    it("accepts a real child and rejects escapes, siblings and the root itself", () => {
      const root = path.join("/home", "bee", ".ezcoder", "worktrees");
      expect(isInsideWorktreesRoot(root, path.join(root, "repo", "feature"))).toBe(true);
      // The root is not inside itself: removing the container is never meant.
      expect(isInsideWorktreesRoot(root, root)).toBe(false);
      expect(isInsideWorktreesRoot(root, path.join(root, "..", "elsewhere"))).toBe(false);
      // A prefix-string check would wrongly accept this sibling.
      expect(isInsideWorktreesRoot(root, `${root}-evil`)).toBe(false);
      expect(isInsideWorktreesRoot(root, path.join("/etc", "passwd"))).toBe(false);
    });
  });

  describe("redirectedAncestor", () => {
    it("finds a symlink above the path and returns null for a real chain", async () => {
      const base = await makeTempDir("ez-worktree-link-");
      const real = path.join(base, "real");
      await fs.mkdir(path.join(real, "nested"), { recursive: true });
      expect(await redirectedAncestor(path.join(real, "nested"))).toBeNull();

      const link = path.join(base, "link");
      await fs.symlink(real, link, "dir");
      // stat() would follow the link and report an ordinary directory here.
      expect(await redirectedAncestor(path.join(link, "nested"))).toBe(link);
    });
  });

  describe("worktreeStatuses", () => {
    it("reports a fresh copy as reclaimable and the main checkout not at all", async () => {
      const repo = await makeRepo();
      const created = await createWorktree({ repoDir: repo, branch: "clean" });

      const statuses = await worktreeStatuses(repo);
      expect(statuses).toHaveLength(1);
      expect(statuses[0]).toMatchObject({
        path: created.path,
        branch: "clean",
        baseRef: "main",
        dirtyFiles: 0,
        commitsAhead: 0,
        merged: true,
        busy: false,
        reclaimable: true,
        blockedBy: [],
      });
    });

    it("blocks on uncommitted work", async () => {
      const repo = await makeRepo();
      const created = await createWorktree({ repoDir: repo, branch: "wip" });
      await fs.writeFile(path.join(created.path, "scratch.txt"), "in progress\n");

      const [status] = await worktreeStatuses(repo);
      expect(status.reclaimable).toBe(false);
      expect(status.dirtyFiles).toBe(1);
      expect(status.blockedBy.join(" ")).toMatch(/uncommitted/i);
    });

    it("blocks on commits the base branch does not have", async () => {
      const repo = await makeRepo();
      const created = await createWorktree({ repoDir: repo, branch: "ahead" });
      await fs.writeFile(path.join(created.path, "b.txt"), "work\n");
      git(created.path, "add", "b.txt");
      git(created.path, "commit", "-q", "-m", "real work");

      const [status] = await worktreeStatuses(repo);
      expect(status).toMatchObject({ commitsAhead: 1, merged: false, reclaimable: false });
      expect(status.blockedBy.join(" ")).toMatch(/unmerged/i);
    });

    it("keeps judging against the ORIGINAL fork point after main moves on", async () => {
      const repo = await makeRepo();
      const created = await createWorktree({ repoDir: repo, branch: "forked" });

      // Main advances. The copy is now behind, but it still holds no work of
      // its own, so it stays reclaimable.
      await fs.writeFile(path.join(repo, "c.txt"), "later\n");
      git(repo, "add", "c.txt");
      git(repo, "commit", "-q", "-m", "main moves");

      const [status] = await worktreeStatuses(repo);
      expect(status.commitsAhead).toBe(0);
      expect(status.reclaimable).toBe(true);
      expect(created.baseRef).toBe("main");
    });

    it("blocks a copy another window is working in", async () => {
      const repo = await makeRepo();
      const created = await createWorktree({ repoDir: repo, branch: "busy" });

      const [status] = await worktreeStatuses(repo, [created.path]);
      expect(status.busy).toBe(true);
      expect(status.reclaimable).toBe(false);
      expect(await reclaimableWorktrees(repo, [created.path])).toEqual([]);
    });
  });

  describe("removeWorktree", () => {
    it("frees the path and the branch", async () => {
      const repo = await makeRepo();
      const created = await createWorktree({ repoDir: repo, branch: "gone" });

      const release = await removeWorktree({ repoDir: repo, worktreePath: created.path });
      expect(release).toMatchObject({ existed: true, freed: true, branchDeleted: true });
      expect(await listWorktrees(repo)).toHaveLength(1);
      expect(() => git(repo, "rev-parse", "--verify", "refs/heads/gone")).toThrow();
    });

    it("refuses a path outside the managed copies folder", async () => {
      const repo = await makeRepo();
      const release = await removeWorktree({ repoDir: repo, worktreePath: repo });
      expect(release.freed).toBe(false);
      expect(release.reason).toMatch(/outside/i);
      // The repo itself is untouched.
      expect(await fs.readFile(path.join(repo, "a.txt"), "utf-8")).toBe("hello\n");
    });

    it("refuses to remove through a symlinked ancestor", async () => {
      const repo = await makeRepo();
      const created = await createWorktree({ repoDir: repo, branch: "linked-away" });
      const root = worktreesRootFor(repo);

      // Swap the container for a link to it: the containment check still reads
      // as contained, so only the lstat walk catches this.
      const moved = `${root}-moved`;
      await fs.rename(root, moved);
      await fs.symlink(moved, root, "dir");

      const release = await removeWorktree({ repoDir: repo, worktreePath: created.path });
      expect(release.freed).toBe(false);
      expect(release.reason).toMatch(/symlink/i);
      // The real tree survived the refusal.
      expect(await fs.readFile(path.join(moved, "linked-away", "a.txt"), "utf-8")).toBe("hello\n");
    });

    it("reports a path that was never there instead of throwing", async () => {
      const repo = await makeRepo();
      const absent = path.join(worktreesRootFor(repo), "never-existed");
      const release = await removeWorktree({ repoDir: repo, worktreePath: absent });
      expect(release).toMatchObject({ existed: false, freed: true });
    });

    it("clears a registered-but-missing copy so the same name works again", async () => {
      const repo = await makeRepo();
      const created = await createWorktree({ repoDir: repo, branch: "ghost" });

      // What a user reclaiming disk with `rm -rf ~/.ezcoder/worktrees` leaves
      // behind: the registration and the branch survive the directory.
      await fs.rm(created.path, { recursive: true, force: true });

      const release = await removeWorktree({ repoDir: repo, worktreePath: created.path });
      expect(release.freed).toBe(true);

      // Without the prune, this would fail with "missing but already registered"
      // and the branch delete would have been refused.
      const again = await createWorktree({ repoDir: repo, branch: "ghost" });
      expect(again.branch).toBe("ghost");
      expect(again.path).toBe(created.path);
    });

    it("leaves unmerged work alone unless forced", async () => {
      const repo = await makeRepo();
      const created = await createWorktree({ repoDir: repo, branch: "precious" });
      await fs.writeFile(path.join(created.path, "wip.txt"), "unsaved\n");

      const refused = await removeWorktree({ repoDir: repo, worktreePath: created.path });
      expect(refused.freed).toBe(false);
      expect(await fs.readFile(path.join(created.path, "wip.txt"), "utf-8")).toBe("unsaved\n");

      const forced = await removeWorktree({
        repoDir: repo,
        worktreePath: created.path,
        force: true,
      });
      expect(forced.freed).toBe(true);
    });
  });

  describe("sweepWorktrees", () => {
    it("removes only the copies that hold nothing, and says why it kept the rest", async () => {
      const repo = await makeRepo();
      const empty = await createWorktree({ repoDir: repo, branch: "empty" });
      const dirty = await createWorktree({ repoDir: repo, branch: "dirty" });
      const ahead = await createWorktree({ repoDir: repo, branch: "ahead" });
      const open = await createWorktree({ repoDir: repo, branch: "open" });

      await fs.writeFile(path.join(dirty.path, "wip.txt"), "x\n");
      await fs.writeFile(path.join(ahead.path, "b.txt"), "work\n");
      git(ahead.path, "add", "b.txt");
      git(ahead.path, "commit", "-q", "-m", "work");

      const result = await sweepWorktrees(repo, [open.path]);

      expect(result.removed.map((s) => s.branch)).toEqual(["empty"]);
      expect(result.kept.map((k) => k.status.branch).sort()).toEqual(["ahead", "dirty", "open"]);
      expect(await pathIsGone(empty.path)).toBe(true);
      expect(await pathIsGone(dirty.path)).toBe(false);
      expect(await pathIsGone(ahead.path)).toBe(false);
      expect(await pathIsGone(open.path)).toBe(false);
    });

    it("is a no-op for a repo with no copies", async () => {
      const repo = await makeRepo();
      expect(await sweepWorktrees(repo)).toEqual({ removed: [], kept: [] });
    });

    it("answers rather than throws for a directory that is not a repo", async () => {
      const plain = await makeTempDir("ez-worktree-nonrepo-");
      expect(await sweepWorktrees(plain)).toEqual({ removed: [], kept: [] });
    });
  });
});
