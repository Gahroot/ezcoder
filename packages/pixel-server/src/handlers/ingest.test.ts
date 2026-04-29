import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestHarness } from "../test-db.js";
import { createProject } from "./projects.js";
import { ingestEvent } from "./ingest.js";
import { patchError } from "./errors.js";
import type { ErrorRow, WireEvent } from "../types.js";

let h: TestHarness;
beforeEach(() => (h = createTestDb()));
afterEach(() => h.close());

const evt = (overrides: Partial<WireEvent> = {}): WireEvent => ({
  event_id: crypto.randomUUID(),
  project_key: "pk_unset",
  fingerprint: "fp1",
  type: "TypeError",
  message: "boom",
  stack: [{ file: "/repo/src/a.ts", line: 1, col: 1, fn: "f", in_app: true }],
  code_context: { file: "/repo/src/a.ts", error_line: 1, lines: ["x"] },
  runtime: "node-22",
  manual_report: false,
  level: "error",
  occurred_at: new Date().toISOString(),
  ...overrides,
});

describe("ingestEvent", () => {
  it("rejects unknown project keys", async () => {
    const result = await ingestEvent(h.db, evt({ project_key: "pk_nope" }));
    expect(result.kind).toBe("unknown_project");
  });

  it("creates a new error row on first occurrence", async () => {
    const project = await createProject(h.db, "myapp");
    const result = await ingestEvent(h.db, evt({ project_key: project.key }));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.created).toBe(true);
    expect(result.recurred).toBe(false);
    expect(result.error.status).toBe("open");
    expect(result.error.occurrences).toBe(1);
  });

  it("bumps occurrences on repeat fingerprint", async () => {
    const project = await createProject(h.db, "myapp");
    await ingestEvent(h.db, evt({ project_key: project.key }));
    await ingestEvent(h.db, evt({ project_key: project.key }));
    const r = await ingestEvent(h.db, evt({ project_key: project.key }));
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.created).toBe(false);
    expect(r.error.occurrences).toBe(3);
  });

  it("dedupes on duplicate event_id (idempotent ingest)", async () => {
    const project = await createProject(h.db, "myapp");
    const eventId = crypto.randomUUID();
    await ingestEvent(h.db, evt({ project_key: project.key, event_id: eventId }));
    const second = await ingestEvent(h.db, evt({ project_key: project.key, event_id: eventId }));
    expect(second.kind).toBe("duplicate");
    const row = await h.db.one<ErrorRow>("SELECT * FROM errors WHERE project_id = ?", [project.id]);
    expect(row?.occurrences).toBe(1);
  });

  it("flips merged → open and bumps recurrence_count when fingerprint reappears after merge", async () => {
    const project = await createProject(h.db, "myapp");
    const first = await ingestEvent(h.db, evt({ project_key: project.key }));
    if (first.kind !== "ok") throw new Error("setup failed");

    await patchError(h.db, first.error.id, { status: "merged" });

    const recurrence = await ingestEvent(h.db, evt({ project_key: project.key }));
    expect(recurrence.kind).toBe("ok");
    if (recurrence.kind !== "ok") return;
    expect(recurrence.recurred).toBe(true);
    expect(recurrence.error.status).toBe("open");
    expect(recurrence.error.recurrence_count).toBe(1);
  });

  it("isolates fingerprints per project (same fingerprint, two projects = two rows)", async () => {
    const a = await createProject(h.db, "a");
    const b = await createProject(h.db, "b");
    await ingestEvent(h.db, evt({ project_key: a.key, fingerprint: "shared" }));
    await ingestEvent(h.db, evt({ project_key: b.key, fingerprint: "shared" }));
    const rows = await h.db.all<ErrorRow>("SELECT * FROM errors", []);
    expect(rows).toHaveLength(2);
  });
});
