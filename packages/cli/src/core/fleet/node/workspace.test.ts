import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  prepareWorkspace,
  prepareWorkspaceDetailed,
  resolveInside,
  sanitizeCacheKey,
} from "./workspace.js";
import { tempDir } from "./__fixtures__/server.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

function makeRepo() {
  const repo = tempDir("ezf-repo-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "uploadpack.allowFilter", "true");
  git(repo, "config", "uploadpack.allowAnySHA1InWant", "true");
  fs.mkdirSync(path.join(repo, "app"));
  fs.writeFileSync(path.join(repo, "app", "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "one");
  const first = git(repo, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "app", "a.txt"), "two\n");
  git(repo, "commit", "-qam", "two");
  return { repo, first, url: pathToFileURL(repo).href };
}

describe("prepareWorkspace", () => {
  it("clones the exact sha and applies a binary patch", async () => {
    const { repo, first, url } = makeRepo();
    // Uncommitted work against `first`: a modified file and a new binary file.
    git(repo, "checkout", "-q", first);
    fs.writeFileSync(path.join(repo, "app", "a.txt"), "patched\n");
    fs.writeFileSync(path.join(repo, "app", "bin.dat"), Buffer.from([0, 1, 2, 255]));
    git(repo, "add", "-A", "-N");
    const patch = execFileSync("git", ["diff", "--binary", first], { cwd: repo });
    git(repo, "checkout", "-q", "-f", "main");

    const dataDir = tempDir();
    const ws = await prepareWorkspaceDetailed({
      dataDir,
      kind: "job",
      id: "w1",
      source: { git: url, sha: first, patch: patch.toString("base64"), subdir: "app" },
    });
    expect(ws.root).toBe(path.join(dataDir, "jobs", "w1"));
    expect(ws.cwd).toBe(path.join(ws.root, "app"));
    expect(ws.subdir).toBe("app");
    expect(fs.readFileSync(path.join(ws.cwd, "a.txt"), "utf8")).toBe("patched\n");
    expect([...fs.readFileSync(path.join(ws.cwd, "bin.dat"))]).toEqual([0, 1, 2, 255]);
    expect(git(ws.root, "rev-parse", "HEAD")).toBe(first);
  });

  it("fails clearly for a missing sha or a bad subdir", async () => {
    const { first, url } = makeRepo();
    const dataDir = tempDir();
    await expect(
      prepareWorkspace({
        dataDir,
        kind: "job",
        id: "w2",
        source: { git: url, sha: "deadbeef".repeat(5) },
      }),
    ).rejects.toThrow();
    await expect(
      prepareWorkspace({
        dataDir,
        kind: "job",
        id: "w3",
        source: { git: url, sha: first, subdir: "../x" },
      }),
    ).rejects.toThrow(/escapes/);
    await expect(
      prepareWorkspace({ dataDir, kind: "job", id: "../evil", source: { git: url, sha: first } }),
    ).rejects.toThrow(/invalid id/);
  });

  it("makes an empty workspace without a source", async () => {
    const dataDir = tempDir();
    const cwd = await prepareWorkspace({ dataDir, kind: "service", id: "s1" });
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it("keeps paths and cache keys inside their roots", () => {
    expect(() => resolveInside("/a/b", "/etc")).toThrow();
    expect(() => resolveInside("/a/b", "x/../../c")).toThrow();
    expect(resolveInside("/a/b", "x/y")).toBe(path.resolve("/a/b/x/y"));
    expect(sanitizeCacheKey("you/repo")).toBe("you_repo");
    expect(sanitizeCacheKey("../..")).toBe("default");
  });
});

describe("prepareWorkspace security", () => {
  it("refuses transport-helper git urls", async () => {
    await expect(
      prepareWorkspace({
        dataDir: tempDir(),
        kind: "job",
        id: "w5",
        source: { git: "ext::sh -c touch% /tmp/pwned", sha: "a".repeat(40) },
      }),
    ).rejects.toThrow(/invalid git url/);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a subdir that is a symlink out of the clone",
    async () => {
      const { repo, url } = makeRepo();
      fs.symlinkSync("/", path.join(repo, "root"));
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "link");
      const sha = git(repo, "rev-parse", "HEAD");
      await expect(
        prepareWorkspace({
          dataDir: tempDir(),
          kind: "agent",
          id: "w6",
          source: { git: url, sha, subdir: "root" },
        }),
      ).rejects.toThrow(/escapes/);
    },
  );
});
