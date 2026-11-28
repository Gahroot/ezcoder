import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundleOf, commitSnapshot, isSecretLikePath, workingTreeSnapshot } from "./snapshot.js";

let dir: string;
const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ez-snap-"));
  g("init", "-q");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "a");
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored/\n");
  g("add", ".");
  g("commit", "-qm", "one");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("snapshot", () => {
  it("commit snapshot has exactly the commit's tree, stable across calls", async () => {
    const sha = g("rev-parse", "HEAD");
    const s = await commitSnapshot(dir, sha);
    expect(s.tree).toBe(g("rev-parse", "HEAD^{tree}"));
    expect(g("rev-parse", `${s.commit}^{tree}`)).toBe(s.tree);
    expect((await commitSnapshot(dir, sha)).commit).toBe(s.commit);
    // A root commit: no history goes up.
    expect(g("rev-list", "--count", s.commit)).toBe("1");
  });

  it("working tree snapshot adds local work but withholds secret-like files", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "changed");
    fs.writeFileSync(path.join(dir, "new.txt"), "n");
    fs.writeFileSync(path.join(dir, ".env"), "TOKEN=x");
    fs.mkdirSync(path.join(dir, "ignored"));
    fs.writeFileSync(path.join(dir, "ignored", "x"), "x");
    const before = g("status", "--porcelain");
    const s = await workingTreeSnapshot(dir);
    expect(s.withheld).toEqual([".env"]);
    const files = g("ls-tree", "-r", "--name-only", s.tree).split("\n");
    expect(files.sort()).toEqual([".gitignore", "a.txt", "new.txt"]);
    expect(g("show", `${s.tree}:a.txt`)).toBe("changed");
    // The user's index is untouched.
    expect(g("status", "--porcelain")).toBe(before);
    expect(isSecretLikePath("config/prod.pem")).toBe(true);
    expect(isSecretLikePath("src/env.ts")).toBe(false);
  });

  it("bundle carries HEAD and main at the snapshot", async () => {
    const s = await commitSnapshot(dir, g("rev-parse", "HEAD"));
    const file = path.join(dir, "..", `${path.basename(dir)}.bundle`);
    fs.writeFileSync(file, await bundleOf(dir, s.commit));
    try {
      const heads = g("bundle", "list-heads", file);
      expect(heads).toContain(`${s.commit} HEAD`);
      expect(heads).toContain(`${s.commit} refs/heads/main`);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
