// Isolated per-job/agent/service workspaces: a fresh clone of the project at
// exactly `sha` (blob-less, fetched with the node's own git credentials), plus
// the controller's uncommitted work as a binary patch.
import fs from "node:fs";
import path from "node:path";
import type { SourceSpec } from "../protocol.js";
import { defaultExec, isSafeId, type NodeExec } from "./exec.js";

export type WorkspaceKind = "job" | "agent" | "service";

/** base64 patch limit from the protocol (50 MB of base64). */
export const MAX_PATCH_BASE64 = 50 * 1024 * 1024;

export function workspaceRoot(dataDir: string, kind: WorkspaceKind, id: string): string {
  if (!isSafeId(id)) throw new Error(`invalid id: ${id}`);
  return path.join(dataDir, `${kind}s`, id);
}

/** Sanitized per-project cache folder name. */
export function sanitizeCacheKey(key: string): string {
  const k = key
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 100);
  return k || "default";
}

export function cacheDir(dataDir: string, key: string): string {
  const dir = path.join(dataDir, "cache", sanitizeCacheKey(key));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve `subdir` inside `root`, refusing absolute paths and `..` escapes. */
export function resolveInside(root: string, rel: string | undefined): string {
  if (!rel || rel === "." || rel === "/") return root;
  if (path.isAbsolute(rel) || rel.includes("\0")) throw new Error(`path must be relative: ${rel}`);
  const full = path.resolve(root, rel);
  const back = path.relative(root, full);
  if (back.startsWith("..") || path.isAbsolute(back))
    throw new Error(`path escapes the workspace: ${rel}`);
  return full;
}

/**
 * True when `p` (after resolving symlinks in its existing part) is `root` or
 * inside it. Lexical checks alone miss a repo symlink pointing at `/`.
 */
export function isRealPathInside(root: string, p: string): boolean {
  const real = (x: string): string => {
    let cur = path.resolve(x);
    const tail: string[] = [];
    for (;;) {
      try {
        return path.join(fs.realpathSync(cur), ...tail);
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) return path.resolve(x);
        tail.unshift(path.basename(cur));
        cur = parent;
      }
    }
  };
  const rel = path.relative(real(root), real(p));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Transports a request's `source.git` may use (never `ext::`/`fd::` command helpers). */
export const GIT_ALLOWED_PROTOCOLS = "file:git:http:https:ssh";

function gitEnv(): NodeJS.ProcessEnv {
  // Never block on a credential prompt: the node has no TTY.
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_ALLOW_PROTOCOL: GIT_ALLOWED_PROTOCOLS,
  };
}

export interface PrepareOptions {
  dataDir: string;
  kind: WorkspaceKind;
  id: string;
  source?: SourceSpec;
  exec?: NodeExec;
}

export interface PreparedWorkspace {
  /** Repository root (mounted at /w in Docker). */
  root: string;
  /** Where commands run: root + subdir. */
  cwd: string;
  /** Subdir relative to root ("" when none), POSIX separators. */
  subdir: string;
}

/**
 * Fresh workspace at <dataDir>/<kind>s/<id>. Without a source it is an empty
 * folder. Any previous content for the same id is removed first.
 */
export async function prepareWorkspaceDetailed(opts: PrepareOptions): Promise<PreparedWorkspace> {
  const exec = opts.exec ?? defaultExec;
  const root = workspaceRoot(opts.dataDir, opts.kind, opts.id);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const src = opts.source;
  if (!src) return { root, cwd: root, subdir: "" };
  if (!/^[0-9a-f]{7,64}$/i.test(src.sha)) throw new Error(`invalid sha: ${src.sha}`);
  if (!src.git || src.git.startsWith("-") || /^[A-Za-z][A-Za-z0-9+.-]*::/.test(src.git))
    throw new Error("invalid git url");
  if (src.patch && src.patch.length > MAX_PATCH_BASE64) throw new Error("patch exceeds 50 MB");

  const env = gitEnv();
  const git = async (args: string[], timeoutMs = 10 * 60_000) => {
    const r = await exec("git", args, { cwd: root, env, timeoutMs });
    return r;
  };
  const must = async (args: string[], what: string) => {
    const r = await git(args);
    if (r.code !== 0)
      throw new Error(`${what} failed: ${(r.stderr || r.stdout).trim().slice(-2000)}`);
    return r;
  };

  await must(["init", "-q"], "git init");
  await must(["remote", "add", "origin", src.git], "git remote add");
  // Exact sha first (cheapest); servers that refuse unadvertised shas get all heads + tags.
  let fetched = await git(["fetch", "-q", "--filter=blob:none", "--no-tags", "origin", src.sha]);
  if (fetched.code !== 0) {
    fetched = await git([
      "fetch",
      "-q",
      "--filter=blob:none",
      "--tags",
      "origin",
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
    if (fetched.code !== 0) {
      throw new Error(
        `git fetch failed: ${(fetched.stderr || fetched.stdout).trim().slice(-2000)}`,
      );
    }
  }
  const has = await git(["cat-file", "-e", `${src.sha}^{commit}`]);
  if (has.code !== 0) throw new Error(`commit ${src.sha} not found in ${src.git} (is it pushed?)`);
  await must(
    ["-c", "advice.detachedHead=false", "checkout", "-q", "--detach", src.sha],
    "git checkout",
  );

  if (src.patch) {
    const bytes = Buffer.from(src.patch, "base64");
    if (bytes.length > 0) {
      const patchFile = path.join(opts.dataDir, "tmp", `${opts.kind}-${opts.id}.patch`);
      fs.mkdirSync(path.dirname(patchFile), { recursive: true });
      fs.writeFileSync(patchFile, bytes);
      try {
        await must(["apply", "--binary", "--whitespace=nowarn", patchFile], "git apply");
      } finally {
        fs.rmSync(patchFile, { force: true });
      }
    }
  }

  const cwd = resolveInside(root, src.subdir);
  if (!fs.existsSync(cwd)) throw new Error(`subdir not found: ${src.subdir}`);
  if (!isRealPathInside(root, cwd)) throw new Error(`path escapes the workspace: ${src.subdir}`);
  return { root, cwd, subdir: path.relative(root, cwd).split(path.sep).join("/") };
}

/** NodeContext.prepareWorkspace: returns the working folder (root + subdir). */
export async function prepareWorkspace(opts: PrepareOptions): Promise<string> {
  return (await prepareWorkspaceDetailed(opts)).cwd;
}

export function cleanupWorkspace(dataDir: string, kind: WorkspaceKind, id: string): void {
  fs.rmSync(workspaceRoot(dataDir, kind, id), { recursive: true, force: true });
}
