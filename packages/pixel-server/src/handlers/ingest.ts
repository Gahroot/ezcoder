import { errorId } from "../ids.js";
import type { Db, ErrorRow, WireEvent } from "../types.js";
import { findProjectByKey } from "./projects.js";

export type IngestResult =
  | { kind: "ok"; error: ErrorRow; recurred: boolean; created: boolean }
  | { kind: "duplicate"; error: ErrorRow }
  | { kind: "unknown_project" };

export async function ingestEvent(db: Db, event: WireEvent): Promise<IngestResult> {
  const project = await findProjectByKey(db, event.project_key);
  if (!project) return { kind: "unknown_project" };

  const existing = await db.one<ErrorRow>(
    "SELECT * FROM errors WHERE project_id = ? AND fingerprint = ?",
    [project.id, event.fingerprint],
  );

  const now = Date.now();
  const stackJson = event.stack ? JSON.stringify(event.stack) : null;
  const ctxJson = event.code_context ? JSON.stringify(event.code_context) : null;

  if (!existing) {
    const row: ErrorRow = {
      id: errorId(),
      last_event_id: event.event_id,
      project_id: project.id,
      fingerprint: event.fingerprint,
      status: "open",
      type: event.type,
      message: event.message,
      stack: stackJson,
      code_context: ctxJson,
      runtime: event.runtime,
      occurrences: 1,
      recurrence_count: 0,
      first_seen_at: now,
      last_seen_at: now,
      fixed_at: null,
      merged_at: null,
      branch: null,
    };
    await db.run(
      `INSERT INTO errors (
         id, last_event_id, project_id, fingerprint, status, type, message, stack,
         code_context, runtime, occurrences, recurrence_count, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
      [
        row.id,
        row.last_event_id,
        row.project_id,
        row.fingerprint,
        row.status,
        row.type,
        row.message,
        row.stack,
        row.code_context,
        row.runtime,
        row.first_seen_at,
        row.last_seen_at,
      ],
    );
    return { kind: "ok", error: row, recurred: false, created: true };
  }

  if (existing.last_event_id === event.event_id) {
    return { kind: "duplicate", error: existing };
  }

  const recurred = existing.status === "merged";
  const newStatus = recurred ? "open" : existing.status;
  const newRecurrenceCount = recurred ? existing.recurrence_count + 1 : existing.recurrence_count;

  await db.run(
    `UPDATE errors
       SET last_event_id = ?,
           occurrences = occurrences + 1,
           last_seen_at = ?,
           status = ?,
           recurrence_count = ?,
           type = ?,
           message = ?,
           stack = ?,
           code_context = ?,
           runtime = ?
     WHERE id = ?`,
    [
      event.event_id,
      now,
      newStatus,
      newRecurrenceCount,
      event.type,
      event.message,
      stackJson,
      ctxJson,
      event.runtime,
      existing.id,
    ],
  );

  const updated: ErrorRow = {
    ...existing,
    last_event_id: event.event_id,
    occurrences: existing.occurrences + 1,
    last_seen_at: now,
    status: newStatus,
    recurrence_count: newRecurrenceCount,
    type: event.type,
    message: event.message,
    stack: stackJson,
    code_context: ctxJson,
    runtime: event.runtime,
  };
  return { kind: "ok", error: updated, recurred, created: false };
}
