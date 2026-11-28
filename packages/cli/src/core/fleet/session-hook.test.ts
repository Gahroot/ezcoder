import { describe, expect, it } from "vitest";
import type { AgentNotificationQueue } from "../agent-notifications.js";
import { attachFleetNotifications } from "./session-hook.js";
import {
  FAIL_TAIL_LINES,
  failTailLines,
  fleetJobNotification,
  type FleetEvent,
  type FleetService,
} from "./service.js";
import type { FleetJob } from "./types.js";

const failed = (over: Partial<FleetJob> = {}): FleetJob =>
  ({
    id: "f1",
    name: "test",
    kind: "test",
    project: "/p",
    projectKey: "p",
    git: "g",
    sha: "abcdef1234",
    command: "x",
    timeoutMinutes: 5,
    state: "failed",
    node: "box",
    summary: "exited 1",
    createdAt: "2026-11-27T10:00:00Z",
    updatedAt: "2026-11-27T10:00:00Z",
    ...over,
  }) as FleetJob;

describe("fleet failure notifications (A3)", () => {
  it("keeps the last 30 non-empty lines, each capped", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n\n";
    const tail = failTailLines(text + "x".repeat(400));
    expect(tail).toHaveLength(FAIL_TAIL_LINES);
    expect(tail[0]).toBe("line 22");
    expect(tail.at(-1)!.length).toBe(301);
  });

  it("puts the failing lines into the urgent notification", async () => {
    const enqueued: Array<{ key: string; text: string; opts: unknown }> = [];
    const queue = {
      enqueue: (_src: string, key: string, text: string, opts: unknown) =>
        enqueued.push({ key, text, opts }),
    } as unknown as AgentNotificationQueue;
    let listener: ((e: FleetEvent) => void) | undefined;
    const svc = {
      onEvent: (l: (e: FleetEvent) => void) => {
        listener = l;
        return () => {};
      },
      jobs: { read: async () => [] },
      services: { read: async () => [] },
      start: () => {},
    } as unknown as FleetService;
    attachFleetNotifications(() => "/p", queue, svc);
    listener!({
      type: "job",
      job: failed({ failTail: ["FAIL src/a.test.ts", "expected 1 to be 2"] }),
    } as FleetEvent);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.opts).toMatchObject({ terminal: true, urgent: true });
    expect(enqueued[0]!.text).toContain(
      "Last 2 log lines:\nFAIL src/a.test.ts\nexpected 1 to be 2",
    );
    expect(enqueued[0]!.text).toContain("fleet logs f1");
  });

  it("falls back to pointing at the log when there is no tail", () => {
    expect(fleetJobNotification(failed())!.text).toMatch(/Read the log with fleet logs f1\.$/);
  });
});
