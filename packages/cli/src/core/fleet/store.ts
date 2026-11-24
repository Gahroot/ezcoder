// Durable controller state under ~/.ezcoder/fleet: JSON lists written under a
// file lock with an atomic rename (same approach as validation/store.ts), the
// user's fleet settings, and the leader lock that lets exactly one process poll.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAppPaths, withFileLock } from "@prestyj/core";

export function defaultFleetDir(): string {
  return path.join(getAppPaths().agentDir, "fleet");
}

export interface JsonListStoreOptions<T> {
  /** Drop old entries on every write (finished jobs, stopped services). */
  prune?: (items: T[]) => T[];
  /** File mode for new files (nodes.json holds tokens: 0600). */
  mode?: number;
}

/** One JSON file `{ version, <key>: T[] }`, read-modify-written under a lock. */
export class JsonListStore<T> {
  readonly file: string;
  constructor(
    readonly dir: string,
    fileName: string,
    private readonly key: string,
    private readonly opts: JsonListStoreOptions<T> = {},
  ) {
    this.file = path.join(dir, fileName);
  }

  async read(): Promise<T[]> {
    try {
      const data = JSON.parse(await fs.readFile(this.file, "utf8")) as Record<string, unknown>;
      const list = data[this.key];
      return Array.isArray(list) ? (list as T[]) : [];
    } catch {
      return [];
    }
  }

  /** Read-modify-write under the lock. `fn` mutates the array in place and may return a value. */
  async update<R>(fn: (items: T[]) => R | Promise<R>): Promise<R> {
    await fs.mkdir(this.dir, { recursive: true });
    return withFileLock(this.file, async () => {
      const items = await this.read();
      const result = await fn(items);
      const kept = this.opts.prune ? this.opts.prune(items) : items;
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ version: 1, [this.key]: kept }, null, 2), {
        mode: this.opts.mode ?? 0o644,
      });
      await fs.rename(tmp, this.file);
      return result;
    });
  }
}

export interface FleetSettings {
  /** Max fleet jobs in flight across all nodes (default 8). */
  maxConcurrent?: number;
  /** Fleet browser service (id, or `node/name`) the `browser` tool connects to. */
  browser?: string;
}

export function readFleetSettings(dir = defaultFleetDir()): FleetSettings {
  for (const name of ["settings.json", "settings"]) {
    try {
      const raw = JSON.parse(fsSync.readFileSync(path.join(dir, name), "utf8")) as unknown;
      if (raw && typeof raw === "object") return raw as FleetSettings;
    } catch {
      // missing or unreadable: defaults
    }
  }
  return {};
}

export function writeFleetSettings(dir: string, settings: FleetSettings): void {
  fsSync.mkdirSync(dir, { recursive: true });
  fsSync.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LeaderRecord {
  pid: number;
  host: string;
  at: number;
}

/** Leader election through `<dir>/leader.json` (mirrors ValidationService.lead). */
export class LeaderLock {
  readonly file: string;
  constructor(
    readonly dir: string,
    private readonly staleMs: number,
  ) {
    this.file = path.join(dir, "leader.json");
  }

  /** Take or keep leadership; false when another live process leads. */
  async lead(): Promise<boolean> {
    await fs.mkdir(this.dir, { recursive: true });
    return withFileLock(this.file, async () => {
      try {
        const cur = JSON.parse(await fs.readFile(this.file, "utf8")) as LeaderRecord;
        const mine = cur.pid === process.pid && cur.host === os.hostname();
        const live = cur.host === os.hostname() ? pidAlive(cur.pid) : true;
        if (!mine && live && Date.now() - cur.at < this.staleMs) return false;
      } catch {
        // no leader yet
      }
      await fs.writeFile(
        this.file,
        JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }),
      );
      return true;
    });
  }

  /** Is some live process on this machine leading? */
  async alive(): Promise<boolean> {
    try {
      const cur = JSON.parse(await fs.readFile(this.file, "utf8")) as LeaderRecord;
      return cur.host === os.hostname() && pidAlive(cur.pid) && Date.now() - cur.at < this.staleMs;
    } catch {
      return false;
    }
  }
}
