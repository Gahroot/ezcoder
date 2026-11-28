import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FleetNode } from "../core/fleet/registry.js";
import type { DoctorReport, NodeInfo } from "../core/fleet/protocol.js";
import type { FleetService, NodeSummary, RunOptions } from "../core/fleet/service.js";
import type { FleetJob } from "../core/fleet/types.js";
import { createFleetTool, describeWaiting } from "./fleet.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ezf-tool-"));
  dirs.push(d);
  return d;
}

const node = (name: string): FleetNode =>
  ({ name, url: `http://${name}:7377`, token: "t", labels: [] }) as unknown as FleetNode;

const info = (over: Partial<NodeInfo> = {}): NodeInfo =>
  ({
    ezcoderNode: true,
    protocol: 2,
    name: "box",
    version: "5.38.0",
    platform: "linux",
    hostname: "box",
    arch: "x64",
    cpus: 8,
    memoryGb: 32,
    memoryFreeGb: 20,
    load: 0.1,
    diskFreeGb: 100,
    gpus: [],
    docker: true,
    labels: ["gpu"],
    slots: 4,
    slotsUsed: 4,
    modelAuth: true,
    jobs: [],
    services: [],
    agents: [],
    ...over,
  }) as NodeInfo;

const job = (over: Partial<FleetJob>): FleetJob =>
  ({
    id: "f1",
    name: "e2e",
    kind: "browser",
    project: "/p",
    projectKey: "p",
    git: "g",
    sha: "abcdef1234",
    command: "x",
    timeoutMinutes: 5,
    state: "queued",
    createdAt: "2026-11-27T10:00:00Z",
    updatedAt: "2026-11-27T10:00:00Z",
    ...over,
  }) as FleetJob;

interface Fake {
  runs: Array<{ name: string; opts: RunOptions }>;
  logQueries: unknown[];
  doctorRepos: Array<string | undefined>;
}

function fakeService(over: Record<string, unknown> = {}): { svc: FleetService; fake: Fake } {
  const fake: Fake = { runs: [], logQueries: [], doctorRepos: [] };
  let n = 0;
  const report: DoctorReport = {
    node: "box",
    version: "5.38.0",
    protocol: 2,
    ok: false,
    checks: [
      { id: "git", status: "fail", detail: "can't read repo", fix: "gh auth login" },
      { id: "disk", status: "ok", detail: "100 GB free" },
    ],
  };
  const svc = {
    run: async (_cwd: string, name: string, opts: RunOptions) => {
      fake.runs.push({ name, opts });
      return { job: job({ id: `f${++n}`, name }), messages: ["Uses the pushed commit."] };
    },
    nodes: async (): Promise<NodeSummary[]> => [
      { node: node("box"), online: true, info: info({ dockerOnly: true }), active: 0 },
      {
        node: node("old"),
        online: true,
        info: info(),
        active: 0,
        incompatible: "update the node (ezcoder node update)",
      },
      { node: node("gone"), online: false, error: "connect ECONNREFUSED", active: 0 },
    ],
    client: () => ({
      doctor: async (repo?: string) => {
        fake.doctorRepos.push(repo);
        return report;
      },
      logs: async (_id: string, q: unknown) => {
        fake.logQueries.push(q);
        return { text: "FAIL a.test.ts\nFAIL b.test.ts", size: 9000, truncated: false };
      },
    }),
    registry: { get: async (name: string) => (name === "box" ? node("box") : undefined) },
    get: async (id: string) =>
      id === "f9" ? job({ id, state: "running", node: "box", remoteId: "r9" }) : undefined,
    logs: async () => "plain log",
    config: () => ({ jobs: { e2e: {} }, services: { llm: {} }, source: "auto", notes: [] }),
    // Every project's jobs count for the queue position; this project only has f2.
    list: async (cwd?: string) => [
      ...(cwd ? [] : [job({ id: "other", project: "/q", createdAt: "2026-11-27T09:00:00Z" })]),
      job({ id: "f2", summary: "waiting: box is full", waitWarned: true }),
    ],
    cloudLines: async () => [],
    ...over,
  } as unknown as FleetService;
  return { svc, fake };
}

const exec = (tool: ReturnType<typeof createFleetTool>, args: Record<string, unknown>) =>
  tool.execute(args as never, {} as never) as Promise<string>;

describe("fleet tool", () => {
  it("A1: runs an ad hoc command in an image, and N shards at once", async () => {
    const { svc, fake } = fakeService();
    const tool = createFleetTool("/p", () => svc);
    const out = await exec(tool, {
      action: "run",
      command: "pnpm test",
      image: "node:22",
      timeout_minutes: 20,
      count: 3,
    });
    expect(fake.runs).toHaveLength(3);
    expect(fake.runs[0]!.opts.spec).toMatchObject({
      kind: "custom",
      command: "pnpm test",
      docker: { image: "node:22" },
      timeoutMinutes: 20,
    });
    expect(fake.runs.map((r) => r.opts.shard)).toEqual([
      { index: 1, total: 3 },
      { index: 2, total: 3 },
      { index: 3, total: 3 },
    ]);
    expect(out).toContain("shard 3/3");
    expect(out.match(/Uses the pushed commit/g)).toHaveLength(1);
    expect(await exec(tool, { action: "run" })).toMatch(/needs name .* or command/);
    await exec(tool, { action: "run", name: "e2e" });
    expect(fake.runs.at(-1)).toMatchObject({ name: "e2e", opts: {} });
  });

  it("A2: logs with tail/grep go through the node query", async () => {
    const { svc, fake } = fakeService();
    const tool = createFleetTool("/p", () => svc);
    const out = await exec(tool, { action: "logs", id: "f9", tail: 50, grep: "FAIL" });
    expect(fake.logQueries).toEqual([{ tail: 50, grep: "FAIL" }]);
    expect(out).toContain("FAIL b.test.ts");
    expect(out).toContain("9000 bytes");
    expect(await exec(tool, { action: "logs", id: "f9" })).toBe("plain log");
    expect(await exec(tool, { action: "logs", id: "nope", tail: 5 })).toBe("No job nope.");
  });

  it("A4: doctor says per node whether it is usable and why", async () => {
    const { svc, fake } = fakeService();
    const tool = createFleetTool("/p", () => svc, {
      originUrl: async () => "https://user:secret@github.com/you/repo",
    });
    const out = await exec(tool, { action: "doctor" });
    expect(fake.doctorRepos).toEqual(["https://user:secret@github.com/you/repo"]);
    expect(out).not.toContain("secret@");
    expect(out).toMatch(/box: NOT READY; slots 0\/4 free \(full/);
    expect(out).toContain("labels gpu");
    expect(out).toContain("docker-only");
    expect(out).toContain("git: can't read repo (fix on box: gh auth login)");
    expect(out).toMatch(/old: NOT USABLE \(incompatible\): update the node/);
    expect(out).toMatch(/gone: NOT USABLE \(unreachable: connect ECONNREFUSED\)/);
    expect(out).toContain("ezcoder node serve");
  });

  it("A6: status shows queue position and the waiting reason", async () => {
    const { svc } = fakeService();
    const out = await exec(
      createFleetTool("/p", () => svc),
      { action: "status" },
    );
    expect(out).toContain("[queue position 2 of 2; waiting: box is full]");
    expect(describeWaiting(job({ id: "a" }), [job({ id: "a" })])).toBe(
      "queue position 1 of 1; waiting for a node with room",
    );
    expect(describeWaiting(job({ state: "running" }), [])).toBeUndefined();
  });

  it("A7: proposes a config and writes it only after approval", async () => {
    const cwd = tmp();
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } }),
    );
    fs.writeFileSync(path.join(cwd, "playwright.config.ts"), "");
    fs.writeFileSync(path.join(cwd, "Dockerfile"), "FROM node:22");
    const { svc } = fakeService();
    const plain = createFleetTool(cwd, () => svc);
    const proposal = await exec(plain, { action: "propose_config" });
    expect(proposal).toContain('"e2e"');
    expect(proposal).toContain('"test"');
    expect(proposal).toContain('"image"');
    expect(proposal).toContain('"e2e": "fleet"');
    const file = path.join(cwd, ".ezcoder", "fleet.json");
    expect(fs.existsSync(file)).toBe(false);

    expect(await exec(plain, { action: "apply_config" })).toMatch(/not written/);
    expect(fs.existsSync(file)).toBe(false);

    let asked = 0;
    const no = createFleetTool(cwd, () => svc, {
      ask: async () => {
        asked++;
        return { action: "answer", answers: { apply: "no" } };
      },
    });
    expect(await exec(no, { action: "apply_config", approved: true })).toMatch(/did not approve/);
    expect(asked).toBe(1);
    expect(fs.existsSync(file)).toBe(false);

    const yes = createFleetTool(cwd, () => svc, {
      ask: async () => ({ action: "answer", answers: { apply: "yes" } }),
    });
    expect(await exec(yes, { action: "apply_config" })).toMatch(/^Wrote /);
    const written = JSON.parse(fs.readFileSync(file, "utf8")) as { defaults: object };
    expect(written.defaults).toMatchObject({ e2e: "fleet" });

    expect(await exec(plain, { action: "apply_config", approved: true })).toMatch(
      /already exists; pass overwrite: true/,
    );
    expect(
      await exec(plain, {
        action: "apply_config",
        approved: true,
        overwrite: true,
        config: { jobs: {}, defaults: { e2e: "cloud" } },
      }),
    ).toMatch(/must be "fleet" or "local"/);
  });
});
