import fs from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAppPaths } from "./paths.js";
import { log } from "./logger.js";

// Anthropic's OAuth edge validates the claude-cli UA version: it rejects a UA
// that lags too far behind the real Claude Code release, and it gates brand-new
// models on a minimum client version ("version 2.1.280 or newer is required").
// Resolve dynamically from the npm registry so we never ship a stale-version
// time bomb.
const NPM_LATEST_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";
// Serve a cached version instantly while it is this young.
const CACHE_FRESH_MS = 60 * 60 * 1000;
// Past this age the cache is too risky to serve blind: block on a refresh and
// only fall back to the stale value if npm is genuinely unreachable.
const CACHE_HARD_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;
// Last known good version at publish time. Used only when the npm fetch fails
// and no on-disk cache exists (e.g. first run on an offline machine). Keep
// reasonably current — bump on each ezcoder release.
const FALLBACK_VERSION = "2.1.280";

type CachedVersion = {
  version: string;
  fetchedAt: number;
  /**
   * Highest version Anthropic has explicitly demanded from us, learned from a
   * rejected request. Persisted so a restart cannot walk back into the same
   * lockout, and so the floor survives an npm registry that lags behind.
   */
  minVersion?: string;
};

let memoryCache: { version: string; expiresAt: number } | null = null;
let inflight: Promise<string> | null = null;
let backgroundRefresh: Promise<unknown> | null = null;
let versionFloor: string | null = null;

function cachePath(): string {
  return path.join(getAppPaths().agentDir, "claude-code-version.json");
}

/**
 * Compare two dotted version strings numerically.
 *
 * Returns >0 when `a` is newer, <0 when older, 0 when equal. Segment-wise
 * numeric comparison matters here: Claude Code is deep into 2.1.x, where a
 * lexical compare puts "2.1.9" above "2.1.280" and would happily serve a UA
 * that Anthropic rejects.
 */
export function compareClaudeCodeVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .split(".")
      .map((part) => Number.parseInt(part, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Raise `version` to the recorded floor, if Anthropic has demanded a higher one. */
function applyFloor(version: string): string {
  if (!versionFloor) return version;
  return compareClaudeCodeVersions(versionFloor, version) > 0 ? versionFloor : version;
}

async function readDiskCache(): Promise<CachedVersion | null> {
  try {
    const raw = await fs.readFile(cachePath(), "utf-8");
    const parsed = JSON.parse(raw) as CachedVersion;
    if (typeof parsed.version === "string" && typeof parsed.fetchedAt === "number") {
      if (typeof parsed.minVersion === "string") {
        // Adopt a floor learned by an earlier run/process.
        if (!versionFloor || compareClaudeCodeVersions(parsed.minVersion, versionFloor) > 0) {
          versionFloor = parsed.minVersion;
        }
      }
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeDiskCache(data: CachedVersion): Promise<void> {
  try {
    await fs.mkdir(getAppPaths().agentDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      cachePath(),
      JSON.stringify({ ...data, ...(versionFloor ? { minVersion: versionFloor } : {}) }),
      { mode: 0o600 },
    );
  } catch (err) {
    log(
      "WARN",
      "claude-code-version",
      `Failed to write cache: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function fetchLatest(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(NPM_LATEST_URL, { signal: controller.signal });
    if (!response.ok) return null;
    const data = (await response.json()) as { version?: unknown };
    if (typeof data.version === "string" && /^\d/.test(data.version)) {
      return data.version;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Refresh the cache without blocking the caller. Errors are swallowed. */
function refreshInBackground(): void {
  if (backgroundRefresh) return;
  backgroundRefresh = (async () => {
    const fetched = await fetchLatest();
    if (fetched) {
      await writeDiskCache({ version: fetched, fetchedAt: Date.now() });
      memoryCache = { version: applyFloor(fetched), expiresAt: Date.now() + CACHE_FRESH_MS };
    }
  })()
    .catch(() => {})
    .finally(() => {
      backgroundRefresh = null;
    });
}

/**
 * Resolve the current Claude Code release version for spoofing the claude-cli
 * User-Agent on OAuth and inference requests.
 *
 * A cached value under an hour old is served straight away. An older one is
 * still served immediately — the hot path never waits on npm — but triggers a
 * background refresh, so a client-version gate on a newly released model costs
 * at most one request instead of a full day of lockout. Past 24h the cache is
 * refreshed synchronously, and only falls back to the stale value (then the
 * bundled constant) if npm cannot be reached at all.
 */
export async function getClaudeCodeVersion(): Promise<string> {
  if (memoryCache && Date.now() < memoryCache.expiresAt) {
    return memoryCache.version;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    // Also loads any persisted floor from a previous process.
    const disk = await readDiskCache();
    const age = disk ? Date.now() - disk.fetchedAt : Infinity;

    if (disk && age < CACHE_FRESH_MS) {
      const version = applyFloor(disk.version);
      memoryCache = { version, expiresAt: Date.now() + CACHE_FRESH_MS };
      return version;
    }

    if (disk && age < CACHE_HARD_MS) {
      // Stale-while-revalidate: answer now, correct ourselves for next time.
      const version = applyFloor(disk.version);
      memoryCache = { version, expiresAt: Date.now() + 5 * 60 * 1000 };
      refreshInBackground();
      return version;
    }

    const fetched = await fetchLatest();
    if (fetched) {
      await writeDiskCache({ version: fetched, fetchedAt: Date.now() });
      const version = applyFloor(fetched);
      memoryCache = { version, expiresAt: Date.now() + CACHE_FRESH_MS };
      return version;
    }

    // npm unreachable — prefer stale disk cache over hardcoded fallback.
    const resolved = applyFloor(disk?.version ?? FALLBACK_VERSION);
    // Short TTL so we retry the npm fetch soon, but don't hammer it.
    memoryCache = { version: resolved, expiresAt: Date.now() + 5 * 60 * 1000 };
    log(
      "WARN",
      "claude-code-version",
      `Failed to fetch latest Claude Code version; using ${resolved}`,
    );
    return resolved;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

const REQUIRED_VERSION_PATTERN = /version\s+(\d+(?:\.\d+)+)\s+or\s+newer\s+is\s+required/i;

/**
 * Learn the minimum client version from a provider rejection.
 *
 * Anthropic gates newly released models on a minimum Claude Code version and
 * names it in the error ("version 2.1.280 or newer is required"). That message
 * is authoritative — more current than the npm registry can be at launch — so
 * we pin it as a floor, persist it, and drop the memoised value. The next
 * request builds its User-Agent from the floor and succeeds.
 *
 * Returns the newly applied floor, or null when the error is unrelated.
 */
export function recordRequiredClaudeCodeVersion(message: string): string | null {
  const required = REQUIRED_VERSION_PATTERN.exec(message ?? "")?.[1];
  if (!required) return null;
  if (versionFloor && compareClaudeCodeVersions(required, versionFloor) <= 0) return versionFloor;

  versionFloor = required;
  memoryCache = null;
  log(
    "WARN",
    "claude-code-version",
    `Provider requires Claude Code >= ${required}; pinning User-Agent floor`,
  );
  // Persist the floor so a restart cannot fall back into the same lockout.
  // Written synchronously and deliberately: this runs on a failed turn, the
  // payload is a few dozen bytes, and an async write can lose the race against
  // a process that exits right after the error - which would drop the floor and
  // put the user straight back into the lockout on next launch.
  try {
    const dir = getAppPaths().agentDir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let existing: Partial<CachedVersion> = {};
    try {
      existing = JSON.parse(readFileSync(cachePath(), "utf-8")) as Partial<CachedVersion>;
    } catch {
      // No usable cache yet - the floor alone is still worth persisting.
    }
    writeFileSync(
      cachePath(),
      JSON.stringify({
        version: existing.version ?? required,
        fetchedAt: existing.fetchedAt ?? 0,
        minVersion: required,
      }),
      { mode: 0o600 },
    );
  } catch (err) {
    log(
      "WARN",
      "claude-code-version",
      `Failed to persist required version: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return required;
}

/** Build the User-Agent string Anthropic's OAuth + inference edges expect. */
export async function getClaudeCliUserAgent(): Promise<string> {
  const version = await getClaudeCodeVersion();
  return `claude-cli/${version} (external, cli)`;
}
