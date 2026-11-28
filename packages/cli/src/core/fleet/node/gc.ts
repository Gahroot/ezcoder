// R5: the node cleans up after itself while it runs. Finished job folders
// (workspace, run dir with the log, artifacts) older than gcDays are removed,
// and caches beyond cacheCapGb are trimmed, least recently used first. The
// caller says what is in use; anything it calls busy is never touched.
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_GC_DAYS = 7;
export const DEFAULT_CACHE_CAP_GB = 20;
export const DEFAULT_GC_INTERVAL_MS = 60 * 60_000;

const DAY_MS = 86_400_000;
const GB = 1024 ** 3;

/** Folders under dataDir that hold per-job files, keyed by job id. */
const JOB_DIRS = ["jobs", "run", "artifacts"] as const;

export interface GcOptions {
  dataDir: string;
  /** Default DEFAULT_GC_DAYS. Read on every sweep, so a config change applies live. */
  gcDays?: () => number | undefined;
  /** Default DEFAULT_CACHE_CAP_GB. */
  cacheCapGb?: () => number | undefined;
  /** True for a job id that is still preparing or running (its folders are kept). */
  jobBusy: (id: string) => boolean;
  /** True for a cache folder name a running job uses (never trimmed). */
  cacheBusy: (name: string) => boolean;
  /** When a finished job ended (ms); falls back to the newest mtime of its folders. */
  finishedAt?: (id: string) => number | undefined;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface GcResult {
  /** Job ids whose folders were removed. */
  jobs: string[];
  /** Cache folder names removed. */
  caches: string[];
  freedBytes: number;
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Total bytes and newest file mtime under `p` (symlinks are not followed).
 * Folder mtimes are ignored (creating a folder is not use), unless there are no files.
 */
export function treeStats(p: string): { bytes: number; newest: number } {
  let bytes = 0;
  let newest = 0;
  let newestDir = 0;
  const walk = (cur: string) => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return;
    }
    if (!st.isDirectory()) {
      newest = Math.max(newest, st.mtimeMs);
      bytes += st.size;
      return;
    }
    newestDir = Math.max(newestDir, st.mtimeMs);
    let entries: string[];
    try {
      entries = fs.readdirSync(cur);
    } catch {
      return;
    }
    for (const e of entries) walk(path.join(cur, e));
  };
  walk(p);
  return { bytes, newest: newest || newestDir };
}

function remove(p: string): boolean {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** One sweep. Safe to call at any time; errors on single folders are skipped. */
export function sweepNode(o: GcOptions): GcResult {
  const now = (o.now ?? Date.now)();
  const days = o.gcDays?.() ?? DEFAULT_GC_DAYS;
  const capGb = o.cacheCapGb?.() ?? DEFAULT_CACHE_CAP_GB;
  const result: GcResult = { jobs: [], caches: [], freedBytes: 0 };

  // ── finished jobs ──
  const ids = new Set(JOB_DIRS.flatMap((d) => listDirs(path.join(o.dataDir, d))));
  for (const id of ids) {
    if (o.jobBusy(id)) continue;
    const folders = JOB_DIRS.map((d) => path.join(o.dataDir, d, id)).filter((f) =>
      fs.existsSync(f),
    );
    const stats = folders.map(treeStats);
    const ended = o.finishedAt?.(id) ?? Math.max(...stats.map((s) => s.newest));
    if (!(now - ended > days * DAY_MS)) continue;
    // Re-check right before deleting: a job may have started meanwhile.
    if (o.jobBusy(id)) continue;
    let removed = false;
    folders.forEach((f, i) => {
      if (remove(f)) {
        removed = true;
        result.freedBytes += stats[i]!.bytes;
      }
    });
    if (removed) result.jobs.push(id);
  }

  // ── caches, least recently used first ──
  const cacheRoot = path.join(o.dataDir, "cache");
  const caches = listDirs(cacheRoot).map((name) => ({
    name,
    ...treeStats(path.join(cacheRoot, name)),
  }));
  let total = caches.reduce((n, c) => n + c.bytes, 0);
  const cap = capGb * GB;
  for (const c of caches.sort((a, b) => a.newest - b.newest)) {
    if (total <= cap) break;
    if (o.cacheBusy(c.name)) continue;
    if (remove(path.join(cacheRoot, c.name))) {
      total -= c.bytes;
      result.freedBytes += c.bytes;
      result.caches.push(c.name);
    }
  }

  if (result.jobs.length || result.caches.length) {
    o.log?.(
      `gc: removed ${result.jobs.length} finished job(s) older than ${days} days and ` +
        `${result.caches.length} cache(s) over the ${capGb} GB cap, ${(result.freedBytes / GB).toFixed(2)} GB freed`,
    );
  }
  return result;
}

export interface GcSweeper {
  /** Run a sweep now (also what the timer calls). */
  sweep(): GcResult;
  stop(): void;
}

/** Sweep every `intervalMs` (call `sweep()` yourself for one at start). */
export function startGcSweeper(
  o: GcOptions & {
    intervalMs?: number;
    setInterval?: (fn: () => void, ms: number) => unknown;
    clearInterval?: (handle: unknown) => void;
  },
): GcSweeper {
  const set = o.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clear =
    o.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const sweep = () => {
    try {
      return sweepNode(o);
    } catch (e) {
      o.log?.(`gc failed: ${(e as Error).message}`);
      return { jobs: [], caches: [], freedBytes: 0 };
    }
  };
  const handle = set(sweep, o.intervalMs ?? DEFAULT_GC_INTERVAL_MS);
  (handle as { unref?: () => void } | undefined)?.unref?.();
  return { sweep, stop: () => clear(handle) };
}
