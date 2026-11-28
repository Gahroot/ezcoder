import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRepo } from "../core/fleet/__fixtures__/test-node.js";
import { FLEET_PROTOCOL, type GoalHostStatus } from "../core/fleet/protocol.js";
import { getGoalRun, upsertGoalRun } from "../core/goal-store.js";
import { runGoals } from "./goals.js";

let root: string;
let nodesFile: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ez-cli-goals-")));
  process.env.EZ_GOALS_BASE = path.join(root, "goals");
  nodesFile = path.join(root, "nodes.json");
  fs.writeFileSync(
    nodesFile,
    JSON.stringify({ nodes: [{ name: "box", url: "http://box.test:7377", token: "tok" }] }),
  );
});
afterEach(() => {
  delete process.env.EZ_GOALS_BASE;
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

function stubNode(goal: GoalHostStatus) {
  const posted: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const route = new URL(String(input)).pathname;
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (route === "/v1/info") {
        return json({
          ezcoderNode: true,
          protocol: FLEET_PROTOCOL,
          name: "box",
          version: "1",
          modelAuth: true,
          slots: 2,
          slotsUsed: 0,
          load: 0,
          features: ["goals"],
        });
      }
      if (route === "/v1/doctor") {
        return json({ node: "box", version: "1", protocol: FLEET_PROTOCOL, ok: true, checks: [] });
      }
      if (route === "/v1/goals" && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return json({ ...goal, state: "preparing" });
      }
      if (route.startsWith("/v1/goals/")) return json(goal);
      return json({ error: "nope" }, 404);
    }),
  );
  return posted;
}

describe("ezcoder goals", () => {
  it("hosts a goal on a node, then status shows its pushed result branch", async () => {
    const { local, sha } = makeRepo(root);
    await upsertGoalRun(local, {
      id: "g-1234567890",
      title: "Overnight",
      goal: "Do the thing",
      status: "ready",
      successCriteria: ["done"],
    });
    const goal: GoalHostStatus = {
      id: "g-1234567890",
      project: "p",
      state: "done",
      summary: "Goal passed: proven.",
      resultBranch: "ezcoder/goal/g-1234567890",
      resultSha: "0123456789abcdef",
      startedAt: new Date().toISOString(),
    };
    const posted = stubNode(goal);
    const out: string[] = [];
    const deps = { cwd: local, out: (s: string) => out.push(s), fleet: { nodesFile, pollMs: 1 } };
    await runGoals(["host", "g-1234", "--on", "box"], deps);
    expect(out[0]).toBe(
      `Goal "Overnight" now runs on box from clean commit ${sha.slice(0, 12)}. It keeps going with this computer closed; when it finishes, box pushes ezcoder/goal/g-1234567890 to origin.`,
    );
    expect(posted[0]).toMatchObject({
      id: "g-1234567890",
      resultBranch: "ezcoder/goal/g-1234567890",
      source: { sha },
      goal: { run: { id: "g-1234567890" } },
    });
    expect((await getGoalRun(local, "g-1234567890"))?.hosted?.state).toBe("preparing");

    await runGoals(["status"], deps);
    expect(out[1]).toBe(
      "[ready] Overnight (id: g-123456) — no tasks\n" +
        "    hosted on box: done — Goal passed: proven. — result branch ezcoder/goal/g-1234567890 @ 0123456789ab on origin (fetch: git fetch origin ezcoder/goal/g-1234567890)",
    );
    expect((await getGoalRun(local, "g-1234567890"))?.hosted).toMatchObject({
      node: "box",
      state: "done",
      resultSha: "0123456789abcdef",
    });
  });
});
