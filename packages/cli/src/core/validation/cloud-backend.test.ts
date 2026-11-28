import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudSettings } from "../cloud/config.js";
import { RESULT_MARKER } from "../cloud/runner.js";
import type {
  CloudAvailability,
  CloudCommandRecord,
  CloudProvider,
  CloudTaskStatus,
} from "../cloud/types.js";
import { loadBackends } from "./backends.js";
import {
  cloudJobId,
  cloudRunnerCommand,
  CloudValidationBackend,
  UNTRUSTED_SUMMARY,
  type CloudBackendDeps,
} from "./cloud-backend.js";
import { chooseTarget, listTargets } from "./scheduler.js";
import type { MachineInfo, ValidationBackend, ValidationJob } from "./types.js";

const TREE = "e".repeat(40);
let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ez-cloudb-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function job(o: Partial<ValidationJob> = {}): ValidationJob {
  return {
    id: "v1abc",
    project: "/p",
    repo: "acme/proj",
    sha: "c".repeat(40),
    stage: "test",
    run: "remote",
    required: true,
    command: "npm test",
    timeoutMinutes: 10,
    backend: "",
    state: "queued",
    createdAt: "",
    updatedAt: "",
    ...o,
  };
}

class FakeProvider implements CloudProvider {
  readonly id = "claude-cloud" as const;
  status_: CloudTaskStatus = { state: "running", commands: [], turns: 0 };
  started: Parameters<CloudProvider["start"]>[0][] = [];
  archived: string[] = [];
  interrupted: string[] = [];
  async detect(): Promise<CloudAvailability> {
    return { id: this.id, available: true, detail: "ok" };
  }
  async start(req: Parameters<CloudProvider["start"]>[0]) {
    this.started.push(req);
    return {
      provider: this.id,
      id: "session_1",
      url: "https://claude.ai/code/session_1",
      baseTree: TREE,
    };
  }
  async status() {
    return this.status_;
  }
  async send() {}
  async diff() {
    return Buffer.alloc(0);
  }
  async interrupt(h: { id: string }) {
    this.interrupted.push(h.id);
  }
  async archive(h: { id: string }) {
    this.archived.push(h.id);
  }
}

function backend(o: Partial<CloudBackendDeps> = {}, settings: CloudSettings = {}) {
  const provider = new FakeProvider();
  const b = new CloudValidationBackend(path.join(tmp, "logs"), {
    availability: async () => [
      {
        id: "claude-cloud",
        available: true,
        account: "me",
        detail: "me (Max), environment Default",
      },
      { id: "codex-cloud", available: false, detail: "no environment" },
    ],
    provider: () => provider,
    settings: () => settings,
    state: () => ({ utilization: { "claude-cloud": { value: 0.31, at: "" } } }),
    tree: async () => TREE,
    now: () => Date.parse("2026-11-24T12:00:00Z"),
    ...o,
  });
  return { b, provider };
}

const marker = (j: ValidationJob, fields: Record<string, unknown>) =>
  `${RESULT_MARKER} ${JSON.stringify({ job: cloudJobId(j.id), ...fields })}`;
const record = (j: ValidationJob, output: string): CloudCommandRecord => ({
  command: cloudRunnerCommand(j, TREE),
  output,
  isError: false,
});

async function dispatched(b: CloudValidationBackend, o: Partial<ValidationJob> = {}) {
  const j = job({ backend: "cloud", machine: "claude-cloud", ...o });
  const h = await b.dispatch(j);
  return { ...j, ...h, state: "waiting" as const, dispatchedAt: "2026-11-24T11:59:00Z" };
}

describe("CloudValidationBackend", () => {
  it("lists one machine per provider with account, utilization and overflow note", async () => {
    const { b } = backend();
    const ms = await b.machines();
    expect(ms.map((m) => [m.name, m.online, m.cloud, m.slots])).toEqual([
      ["claude-cloud", true, true, 3],
      ["codex-cloud", false, true, 3],
    ]);
    expect(ms[0]!.capacity).toEqual({
      cpus: 4,
      memoryGb: 16,
      labels: ["linux", "cloud", "docker"],
    });
    expect(ms[0]!.detail).toMatch(/me \(Max\).*31% used.*busy, full or offline/);
  });

  it("dispatches the exact runner command with a no-edit, few-turn session", async () => {
    const { b, provider } = backend();
    const j = await dispatched(b);
    expect(j.runId).toBe(`claude-cloud:session_1:${TREE}`);
    const req = provider.started[0]!;
    const cmd = cloudRunnerCommand(j, TREE);
    expect(req.prompt).toContain(cmd);
    expect(req.approveCommand).toBe(cmd);
    expect(req.maxTurns).toBe(4);
    expect(req.disallowedTools).toContain("Edit");
    expect(req.source.sha).toBe(j.sha);
    await expect(b.dispatch(job({ run: "local" }))).rejects.toThrow(/local/);
  });

  it("passes or fails only on the verified record", async () => {
    const { b, provider } = backend();
    const j = await dispatched(b);
    expect((await b.poll(j)).state).toBe("running");

    // The model claims success in text, but no command record: not trusted.
    provider.status_ = {
      state: "idle",
      turns: 1,
      commands: [],
      finalText: marker(j, { verdict: "done", exit: 0, tree: TREE }),
    };
    expect(await b.poll(j)).toMatchObject({ state: "error", lost: UNTRUSTED_SUMMARY });

    provider.status_ = {
      state: "idle",
      turns: 1,
      commands: [
        record(j, `ok\n${marker(j, { verdict: "done", exit: 0, tree: TREE, seconds: 4 })}`),
      ],
    };
    expect(await b.poll(j)).toMatchObject({ state: "passed" });
    expect(await b.logs(j, false)).toBe("ok");
    expect(provider.archived).toContain("session_1");

    provider.status_.commands = [
      record(j, `FAIL x\nexpected 1\n${marker(j, { verdict: "done", exit: 1, tree: TREE })}`),
    ];
    expect(await b.poll(j)).toMatchObject({
      state: "failed",
      summary: expect.stringMatching(/^exit code 1/),
    });

    provider.status_.commands = [
      record(j, marker(j, { verdict: "timeout", exit: 124, tree: TREE })),
    ];
    expect(await b.poll(j)).toMatchObject({
      state: "failed",
      summary: expect.stringMatching(/timed out/),
    });

    provider.status_.commands = [
      record(j, marker(j, { verdict: "wrong-tree", tree: "f".repeat(40) })),
    ];
    expect(await b.poll(j)).toMatchObject({ state: "error", lost: expect.stringMatching(/tree/) });

    // A marker for another job id doesn't count.
    provider.status_.commands = [
      record(j, marker(job({ id: "other" }), { verdict: "done", exit: 0, tree: TREE })),
    ];
    expect((await b.poll(j)).lost).toBe(UNTRUSTED_SUMMARY);
  });

  it("reports a usage limit as blocked and cancels by interrupt + archive", async () => {
    const { b, provider } = backend();
    const j = await dispatched(b);
    provider.status_ = {
      state: "idle",
      turns: 1,
      commands: [],
      usage: { limited: true, resetsAt: "2026-11-25T00:00:00Z" },
    };
    const r = await b.poll(j);
    expect(r.state).toBe("error");
    expect(r.blocked).toMatch(/usage limit/);
    await b.cancel(j);
    expect(provider.interrupted).toEqual(["session_1"]);
  });
});

/** Self-hosted pool: the user's PC with `slots` runners. */
function pc(o: Partial<MachineInfo> = {}): ValidationBackend {
  const m: MachineInfo = {
    name: "pc",
    online: true,
    slots: 2,
    busy: 0,
    platform: ["windows"],
    capacity: { cpus: 16, memoryGb: 15, labels: ["linux", "docker", "gpu"] },
    runsOn: [],
    detail: "",
    ...o,
  };
  return {
    id: "pool",
    kind: "github-actions",
    runs: "remote",
    maxConcurrent: 2,
    machines: async () => [m],
    dispatch: vi.fn(),
    poll: vi.fn(),
    logs: vi.fn(),
    cancel: vi.fn(),
    health: vi.fn(),
  } as unknown as ValidationBackend;
}

const keyOf = (t: unknown) => (t && typeof t === "object" ? (t as { key: string }).key : t);

describe("cloud overflow scheduling", () => {
  it("prefers a free PC slot, overflows to cloud when the PC is full or offline", async () => {
    const { b } = backend();
    expect(keyOf(chooseTarget(job(), await listTargets([pc(), b]), []))).toBe("pool/pc");
    expect(keyOf(chooseTarget(job(), await listTargets([pc({ busy: 2 }), b]), []))).toBe(
      "cloud/claude-cloud",
    );
    expect(keyOf(chooseTarget(job(), await listTargets([pc({ online: false }), b]), []))).toBe(
      "cloud/claude-cloud",
    );
    // Our own jobs fill the PC too.
    const t = await listTargets([pc(), b]);
    const onPc = [1, 2].map((i) =>
      job({ id: `r${i}`, state: "running", backend: "pool", machine: "pc" }),
    );
    expect(keyOf(chooseTarget(job(), t, onPc))).toBe("cloud/claude-cloud");
  });

  it("never sends GPU or oversized stages to the cloud; Docker stages start dockerd", async () => {
    const { b } = backend();
    const full = await listTargets([pc({ busy: 2 }), b]);
    expect(chooseTarget(job({ resources: { labels: ["gpu"] } }), full, [])).toBeUndefined();
    expect(chooseTarget(job({ resources: { cpus: 8 } }), full, [])).toBeUndefined();
    const dockerJob = job({ command: "docker run --rm node:22 sh -c 'npm test'" });
    expect(keyOf(chooseTarget(dockerJob, full, []))).toBe("cloud/claude-cloud");
    expect(cloudRunnerCommand(dockerJob, TREE)).toContain("sudo -n dockerd");
    expect(cloudRunnerCommand(job(), TREE)).not.toContain("dockerd");
    const cloudOnly = await listTargets([b]);
    expect(chooseTarget(job({ resources: { labels: ["windows"] } }), cloudOnly, [])).toBe("none");
  });

  it("manual mode: only pinned stages use it; always mode: a normal candidate", async () => {
    const manual = backend({}, { when: "manual" }).b;
    const t = await listTargets([pc({ busy: 2 }), manual]);
    expect(chooseTarget(job(), t, [])).toBeUndefined();
    expect(keyOf(chooseTarget(job({ backend: "cloud", pinned: true }), t, []))).toBe(
      "cloud/claude-cloud",
    );
    const always = backend({}, { when: "always" }).b;
    const t2 = await listTargets([pc({ busy: 1 }), always]);
    // PC half full (ratio 0.5) vs empty cloud: cloud wins on load.
    expect(keyOf(chooseTarget(job(), t2, []))).toBe("cloud/claude-cloud");
  });

  it("loadBackends adds cloud unless turned off", () => {
    const exec = async () => ({ code: 0, stdout: "", stderr: "" });
    const dir = path.join(tmp, "cfg");
    const deps = { availability: async () => [] };
    let ids = loadBackends(dir, exec, undefined, { settings: {}, deps }).backends.map((x) => x.id);
    expect(ids).toEqual(["local", "cloud"]);
    ids = loadBackends(dir, exec, undefined, {
      settings: { use: ["agents"] },
      deps,
    }).backends.map((x) => x.id);
    expect(ids).toEqual(["local"]);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "backends.json"), JSON.stringify({ cloud: false }));
    ids = loadBackends(dir, exec, undefined, { settings: {}, deps }).backends.map((x) => x.id);
    expect(ids).toEqual(["local"]);
  });
});

describe("unverifiable providers", () => {
  it("never places or dispatches validation on Codex (no recorded command output)", async () => {
    const { b } = backend();
    const ms = await b.machines();
    const codex = ms.find((m) => m.name === "codex-cloud")!;
    expect(codex.online).toBe(false);
    expect(codex.detail).toMatch(/can't be verified/);
    await expect(b.dispatch(job({ machine: "codex-cloud" }))).rejects.toThrow(/can't be verified/);
  });
});
