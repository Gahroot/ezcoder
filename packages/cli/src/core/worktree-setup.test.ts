import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  carryIgnoredConfig,
  detectInstallCommands,
  prepareWorktree,
  resolveInstallLaunch,
} from "./worktree-setup.js";

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

/** A repo whose .gitignore covers the usual local-only paths. */
async function makeRepo(): Promise<string> {
  const repo = await makeTempDir("ez-wt-setup-");
  git(repo, "init", "-q", "-b", "main");
  await fs.writeFile(
    path.join(repo, ".gitignore"),
    "node_modules/\n.env*\n*.env\n.npmrc\nbig.env\n",
  );
  git(repo, "add", ".gitignore");
  git(repo, "commit", "-q", "-m", "initial");
  return repo;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

d("carryIgnoredConfig", () => {
  it("carries ignored config, including nested, and leaves the original in place", async () => {
    const repo = await makeRepo();
    const dest = await makeTempDir("ez-wt-dest-");
    await fs.writeFile(path.join(repo, ".env"), "TOKEN=abc\n");
    await fs.writeFile(path.join(repo, ".npmrc"), "//registry:_authToken=x\n");
    await fs.mkdir(path.join(repo, "apps", "web"), { recursive: true });
    await fs.writeFile(path.join(repo, "apps", "web", ".env.local"), "PORT=3000\n");

    const carried = await carryIgnoredConfig(repo, dest);

    expect(carried.sort()).toEqual([".env", ".npmrc", "apps/web/.env.local"]);
    expect(await fs.readFile(path.join(dest, ".env"), "utf-8")).toBe("TOKEN=abc\n");
    expect(await fs.readFile(path.join(dest, "apps", "web", ".env.local"), "utf-8")).toBe(
      "PORT=3000\n",
    );
    // The source keeps its copy: this is a copy, not a move.
    expect(await fs.readFile(path.join(repo, ".env"), "utf-8")).toBe("TOKEN=abc\n");
  });

  it("never copies package trees, tracked files, or non-config ignored files", async () => {
    const repo = await makeRepo();
    const dest = await makeTempDir("ez-wt-dest-");
    await fs.mkdir(path.join(repo, "node_modules", "left-pad"), { recursive: true });
    await fs.writeFile(path.join(repo, "node_modules", "left-pad", "index.js"), "x\n");
    await fs.writeFile(path.join(repo, "notes.txt"), "scratch\n"); // untracked, not ignored

    const carried = await carryIgnoredConfig(repo, dest);

    expect(carried).toEqual([]);
    expect(await exists(path.join(dest, "node_modules"))).toBe(false);
    expect(await exists(path.join(dest, "notes.txt"))).toBe(false);
  });

  it("skips a symlinked config rather than copying what it points at", async () => {
    const repo = await makeRepo();
    const dest = await makeTempDir("ez-wt-dest-");
    const outside = path.join(await makeTempDir("ez-wt-outside-"), "secret.txt");
    await fs.writeFile(outside, "ELSEWHERE=1\n");
    await fs.symlink(outside, path.join(repo, ".env"));

    const carried = await carryIgnoredConfig(repo, dest);

    expect(carried).toEqual([]);
    expect(await exists(path.join(dest, ".env"))).toBe(false);
  });

  it("skips a file too large to be configuration", async () => {
    const repo = await makeRepo();
    const dest = await makeTempDir("ez-wt-dest-");
    await fs.writeFile(path.join(repo, "big.env"), "x".repeat(70 * 1024));

    expect(await carryIgnoredConfig(repo, dest)).toEqual([]);
    expect(await exists(path.join(dest, "big.env"))).toBe(false);
  });

  it("carries the project's ignored ezcoder commands, skills and agents", async () => {
    const repo = await makeRepo();
    await fs.appendFile(path.join(repo, ".gitignore"), ".ezcoder/\n");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-q", "-m", "ignore ezcoder");
    const dest = await makeTempDir("ez-wt-dest-");
    const ez = path.join(repo, ".ezcoder");
    await fs.mkdir(path.join(ez, "commands"), { recursive: true });
    await fs.mkdir(path.join(ez, "skills", "deploy"), { recursive: true });
    await fs.mkdir(path.join(ez, "plans"), { recursive: true });
    await fs.writeFile(path.join(ez, "commands", "commit.md"), "# commit\n");
    await fs.writeFile(path.join(ez, "skills", "deploy", "SKILL.md"), "# deploy\n");
    await fs.writeFile(path.join(ez, "mcp.json"), "{}\n");
    // Session state is not project config and must stay behind.
    await fs.writeFile(path.join(ez, "plans", "draft.md"), "# draft\n");

    const carried = await carryIgnoredConfig(repo, dest);

    expect(carried.sort()).toEqual([
      ".ezcoder/commands/commit.md",
      ".ezcoder/mcp.json",
      ".ezcoder/skills/deploy/SKILL.md",
    ]);
    expect(await fs.readFile(path.join(dest, ".ezcoder", "commands", "commit.md"), "utf-8")).toBe(
      "# commit\n",
    );
    expect(await exists(path.join(dest, ".ezcoder", "plans"))).toBe(false);
  });

  it("does not duplicate ezcoder config that is already tracked", async () => {
    const repo = await makeRepo();
    const dest = await makeTempDir("ez-wt-dest-");
    await fs.mkdir(path.join(repo, ".ezcoder", "commands"), { recursive: true });
    await fs.writeFile(path.join(repo, ".ezcoder", "commands", "commit.md"), "# commit\n");
    git(repo, "add", ".ezcoder");
    git(repo, "commit", "-q", "-m", "track commands");

    // Tracked means the checkout already has it; carrying would be a no-op at
    // best and a phantom uncommitted change at worst.
    expect(await carryIgnoredConfig(repo, dest)).toEqual([]);
  });

  it("returns nothing instead of throwing when the source is not a repo", async () => {
    const plain = await makeTempDir("ez-wt-plain-");
    const dest = await makeTempDir("ez-wt-dest-");
    await expect(carryIgnoredConfig(plain, dest)).resolves.toEqual([]);
  });
});

describe("detectInstallCommands", () => {
  it("picks the package manager the lockfile names", async () => {
    const dir = await makeTempDir("ez-wt-lock-");
    await fs.writeFile(path.join(dir, "package.json"), "{}\n");
    await fs.writeFile(path.join(dir, "pnpm-lock.yaml"), "\n");
    // A stale second lockfile must not win over pnpm's.
    await fs.writeFile(path.join(dir, "package-lock.json"), "{}\n");

    expect(await detectInstallCommands(dir)).toEqual([{ command: "pnpm", args: ["install"] }]);
  });

  it("falls back to npm for a package.json with no lockfile", async () => {
    const dir = await makeTempDir("ez-wt-lock-");
    await fs.writeFile(path.join(dir, "package.json"), "{}\n");
    expect(await detectInstallCommands(dir)).toEqual([{ command: "npm", args: ["install"] }]);
  });

  it("handles a polyglot repo and skips projects that need no install", async () => {
    const dir = await makeTempDir("ez-wt-lock-");
    await fs.writeFile(path.join(dir, "package.json"), "{}\n");
    await fs.writeFile(path.join(dir, "uv.lock"), "\n");
    await fs.writeFile(path.join(dir, "Cargo.toml"), "\n"); // cargo fetches on build

    expect(await detectInstallCommands(dir)).toEqual([
      { command: "npm", args: ["install"] },
      { command: "uv", args: ["sync"] },
    ]);
  });

  it("finds nothing to run for a repo with no package manifest", async () => {
    const dir = await makeTempDir("ez-wt-lock-");
    await fs.writeFile(path.join(dir, "main.go"), "package main\n");
    expect(await detectInstallCommands(dir)).toEqual([]);
  });
});

describe("resolveInstallLaunch", () => {
  const nodeDir = "C:\\Program Files\\nodejs";
  const npmCli = `${nodeDir}\\node_modules\\npm\\bin\\npm-cli.js`;
  const winEnv = { PATH: `${nodeDir};C:\\tools`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  const on =
    (...files: string[]) =>
    (p: string): boolean =>
      files.includes(p);

  it("runs the command as-is off Windows", () => {
    expect(resolveInstallLaunch({ command: "npm", args: ["install"] }, {}, "darwin")).toEqual({
      command: "npm",
      args: ["install"],
      shell: false,
    });
  });

  it("runs npm on Windows through node and npm's own script, not the .cmd shim", () => {
    const launch = resolveInstallLaunch(
      { command: "npm", args: ["install"] },
      winEnv,
      "win32",
      // PATHEXT is upper-case, and so is the name the lookup probes.
      on(`${nodeDir}\\npm.CMD`, npmCli),
    );
    expect(launch).toEqual({ command: process.execPath, args: [npmCli, "install"], shell: false });
  });

  it("finds npm in the standard Node folder when it is not on PATH", () => {
    const launch = resolveInstallLaunch(
      { command: "npm", args: ["install"] },
      { PATH: "C:\\Windows", PATHEXT: ".EXE;.CMD", ProgramFiles: "C:\\Program Files" },
      "win32",
      on(npmCli),
    );
    expect(launch?.args).toEqual([npmCli, "install"]);
  });

  it("runs a .cmd-only tool through the shell and a real .exe directly", () => {
    expect(
      resolveInstallLaunch(
        { command: "pnpm", args: ["install"] },
        winEnv,
        "win32",
        on("C:\\tools\\pnpm.CMD"),
      ),
    ).toEqual({ command: "pnpm install", args: [], shell: true });
    expect(
      resolveInstallLaunch(
        { command: "uv", args: ["sync"] },
        winEnv,
        "win32",
        on("C:\\tools\\uv.EXE"),
      ),
    ).toEqual({ command: "C:\\tools\\uv.EXE", args: ["sync"], shell: false });
  });

  it("reports a tool that is not installed instead of guessing", () => {
    expect(
      resolveInstallLaunch({ command: "pnpm", args: ["install"] }, winEnv, "win32", on()),
    ).toBeNull();
    expect(
      resolveInstallLaunch({ command: "npm", args: ["install"] }, { PATH: "" }, "win32", on()),
    ).toBeNull();
  });
});

d("prepareWorktree", () => {
  it("carries config and reports success when there is nothing to install", async () => {
    const repo = await makeRepo();
    const dest = await makeTempDir("ez-wt-dest-");
    await fs.writeFile(path.join(repo, ".env"), "TOKEN=abc\n");

    const result = await prepareWorktree({ mainRoot: repo, worktreePath: dest });

    expect(result).toEqual({ carried: [".env"], installs: [], ok: true });
  });

  it("reports a failed install instead of throwing, leaving the copy in place", async () => {
    const repo = await makeRepo();
    const dest = await makeTempDir("ez-wt-dest-");
    await fs.writeFile(path.join(repo, ".env"), "TOKEN=abc\n");
    // A manifest npm will choke on: install fails, preparation still returns.
    await fs.writeFile(path.join(dest, "package.json"), "{ not json\n");

    const result = await prepareWorktree({ mainRoot: repo, worktreePath: dest });

    expect(result.carried).toEqual([".env"]);
    expect(result.ok).toBe(false);
    expect(result.installs).toHaveLength(1);
    expect(result.installs[0]).toMatchObject({ command: "npm install", ok: false });
    expect(result.installs[0]?.message).toBeTruthy();
    // The copy and its carried config survive the failure.
    expect(await fs.readFile(path.join(dest, ".env"), "utf-8")).toBe("TOKEN=abc\n");
  });

  it("skips the install entirely when asked", async () => {
    const repo = await makeRepo();
    const dest = await makeTempDir("ez-wt-dest-");
    await fs.writeFile(path.join(dest, "package.json"), "{ not json\n");

    const result = await prepareWorktree({ mainRoot: repo, worktreePath: dest, skipInstall: true });

    expect(result).toEqual({ carried: [], installs: [], ok: true });
  });
});
