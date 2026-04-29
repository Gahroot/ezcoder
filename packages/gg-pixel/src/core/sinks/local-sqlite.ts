import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { Sink, WireEvent } from "../types.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id      TEXT NOT NULL UNIQUE,
    project_key   TEXT NOT NULL,
    fingerprint   TEXT NOT NULL,
    type          TEXT NOT NULL,
    message       TEXT NOT NULL,
    stack         TEXT NOT NULL,
    code_context  TEXT,
    runtime       TEXT NOT NULL,
    manual_report INTEGER NOT NULL DEFAULT 0,
    level         TEXT NOT NULL,
    occurred_at   TEXT NOT NULL,
    ingested_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS events_fingerprint ON events(project_key, fingerprint);
  CREATE INDEX IF NOT EXISTS events_occurred    ON events(occurred_at);
`;

export class LocalSqliteSink implements Sink {
  private readonly db: Database.Database;
  private readonly insert: Database.Statement;

  constructor(path?: string) {
    const resolved = path ?? join(homedir(), ".gg", "errors.db");
    mkdirSync(dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.insert = this.db.prepare(`
      INSERT INTO events (
        event_id, project_key, fingerprint, type, message, stack, code_context,
        runtime, manual_report, level, occurred_at
      ) VALUES (
        @event_id, @project_key, @fingerprint, @type, @message, @stack, @code_context,
        @runtime, @manual_report, @level, @occurred_at
      )
    `);
  }

  emitSync(event: WireEvent): void {
    this.insert.run({
      event_id: event.event_id,
      project_key: event.project_key,
      fingerprint: event.fingerprint,
      type: event.type,
      message: event.message,
      stack: JSON.stringify(event.stack),
      code_context: event.code_context ? JSON.stringify(event.code_context) : null,
      runtime: event.runtime,
      manual_report: event.manual_report ? 1 : 0,
      level: event.level,
      occurred_at: event.occurred_at,
    });
  }

  async emit(event: WireEvent): Promise<void> {
    this.emitSync(event);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
