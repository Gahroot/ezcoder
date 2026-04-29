import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "./types.js";

export interface TestHarness {
  db: Db;
  raw: Database.Database;
  close(): void;
}

const SCHEMA_URL = new URL("../migrations/0001_init.sql", import.meta.url);

export function createTestDb(): TestHarness {
  const raw = new Database(":memory:");
  raw.exec(readFileSync(fileURLToPath(SCHEMA_URL), "utf8"));
  const db: Db = {
    async one<T>(sql: string, params: unknown[] = []) {
      const stmt = raw.prepare(sql);
      const row = stmt.get(...(params as never[])) as T | undefined;
      return row ?? null;
    },
    async all<T>(sql: string, params: unknown[] = []) {
      const stmt = raw.prepare(sql);
      return stmt.all(...(params as never[])) as T[];
    },
    async run(sql: string, params: unknown[] = []) {
      const stmt = raw.prepare(sql);
      stmt.run(...(params as never[]));
    },
  };
  return {
    db,
    raw,
    close: () => raw.close(),
  };
}
