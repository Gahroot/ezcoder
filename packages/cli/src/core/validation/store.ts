// Durable job state: one JSON file under ~/.ezcoder/validation, written under a
// file lock so the app daemon, CLI sessions and `ezcoder validate` agree.
import fs from "node:fs/promises";
import path from "node:path";
import { getAppPaths, withFileLock } from "@prestyj/core";
import { isTerminal, type ValidationJob } from "./types.js";

export function defaultValidationDir(): string {
  return path.join(getAppPaths().agentDir, "validation");
}

const KEEP_TERMINAL_DAYS = 14;
const KEEP_MAX = 500;

export class JobStore {
  readonly file: string;
  constructor(readonly dir: string) {
    this.file = path.join(dir, "jobs.json");
  }

  async read(): Promise<ValidationJob[]> {
    try {
      const data = JSON.parse(await fs.readFile(this.file, "utf8")) as { jobs?: ValidationJob[] };
      return Array.isArray(data.jobs) ? data.jobs : [];
    } catch {
      return [];
    }
  }

  /** Read-modify-write under the lock. `fn` mutates the array in place and may return a value. */
  async update<T>(fn: (jobs: ValidationJob[]) => T | Promise<T>): Promise<T> {
    await fs.mkdir(this.dir, { recursive: true });
    return withFileLock(this.file, async () => {
      const jobs = await this.read();
      const result = await fn(jobs);
      const cutoff = Date.now() - KEEP_TERMINAL_DAYS * 86_400_000;
      let kept = jobs.filter((j) => !isTerminal(j.state) || Date.parse(j.updatedAt) > cutoff);
      if (kept.length > KEEP_MAX) {
        const active = kept.filter((j) => !isTerminal(j.state));
        const done = kept.filter((j) => isTerminal(j.state)).slice(-(KEEP_MAX - active.length));
        kept = [...done, ...active].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      }
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ version: 1, jobs: kept }, null, 2));
      await fs.rename(tmp, this.file);
      return result;
    });
  }
}
