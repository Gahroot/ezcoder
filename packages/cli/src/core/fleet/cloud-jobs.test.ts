import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CloudSettings } from "../cloud/config.js";
import type {
  CloudAvailability,
  CloudCommandRecord,
  CloudProvider,
  CloudProviderId,
  CloudTaskHandle,
  CloudTaskRequest,
  CloudTaskStatus,
} from "../cloud/types.js";
import { startFakeNode, type FakeNode } from "./__fixtures__/fake-node.js";
import { cloudIneligibility, cloudJobCommand, describeCloudCapacity } from "./cloud-jobs.js";
import type { NodeInfo } from "./protocol.js";
import { NodeRegistry } from "./registry.js";
import { FleetService } from "./service.js";

const TOKEN = "z".repeat(32);
let tmp: string;
let repo: string;
let fleetDir: string;
let nodes: FakeNode[];
let settings: CloudSettings;
let providers: Map<CloudProviderId, FakeCloud>;

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A cloud provider that "runs" the runner command by answering with a marker line. */
class FakeCloud implements CloudProvider {
  started: CloudTaskRequest[] = [];
  interrupted: string[] = [];
  archived: string[] = [];
  available = true;
  /** What a finished task reports: verified (default), a model summary only, or a failure. */
  outcome: "pass" | "fail" | "unverified" = "pass";
  finished = false;
  constructor(readonly id: CloudProviderId) {}
  async detect(): Promise<CloudAvailability> {
    return {
      id: this.id,
      available: this.available,
      detail: this.available ? "signed in" : "not signed in",
      ...(this.available ? {} : { setupHint: `sign in to ${this.id}` }),
    };
  }
  async start(request: CloudTaskRequest): Promise<CloudTaskHandle> {
    this.started.push(request);
    const id = `${this.id}-task-${this.started.length}`;
    return { provider: this.id, id, url: `https://cloud.test/${id}` };
  }
  async status(): Promise<CloudTaskStatus> {
    if (!this.finished) return { state: "running", commands: [], turns: 0 };
    const req = this.started.at(-1)!;
    const command = /```bash\n([\s\S]*)\n```/.exec(req.prompt)![1]!;
    const job = /EZCLOUD-RESULT ([A-Za-z0-9_-]+)/.exec(command)![1]!;
    const tree = /"\$got" != "([0-9a-f]+)"/.exec(command)![1]!;
    const exit = this.outcome === "fail" ? 1 : 0;
    const marker = `EZCLOUD-RESULT {"job":"${job}","verdict":"done","exit":${exit},"tree":"${tree}","seconds":3}`;
    const commands: CloudCommandRecord[] =
      this.outcome === "unverified"
        ? [{ command: "npm run build", output: `ok\n${marker}`, isError: false }]
        : [
            {
              command,
              output: `building\n${exit ? "Error: boom in a.ts\n" : ""}${marker}\n`,
              isError: false,
            },
          ];
    return { state: "idle", commands, turns: 1, finalText: marker };
  }
  async send(): Promise<void> {}
  async diff(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
  async interrupt(h: CloudTaskHandle): Promise<void> {
    this.interrupted.push(h.id);
  }
  async archive(h: CloudTaskHandle): Promise<void> {
    this.archived.push(h.id);
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ezf-cloud-"));
  fleetDir = path.join(tmp, "fleet");
  const bare = path.join(tmp, "origin.git");
  git(tmp, "init", "-q", "--bare", "-b", "main", bare);
  repo = path.join(tmp, "proj");
  fs.mkdirSync(path.join(repo, ".ezcoder"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "remote", "add", "origin", bare);
  fs.writeFileSync(
    path.join(repo, ".ezcoder", "fleet.json"),
    JSON.stringify({
      jobs: {
        build: { kind: "build", command: "npm run build" },
        secret: { kind: "custom", command: "./pub.sh", secrets: ["TOKEN"] },
        pics: { kind: "render", command: "./render.sh", artifacts: ["out/*.png"] },
      },
    }),
  );
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "one");
  git(repo, "push", "-q", "origin", "main");
  nodes = [];
  settings = {};
  providers = new Map([
    ["claude-cloud", new FakeCloud("claude-cloud")],
    ["codex-cloud", new FakeCloud("codex-cloud")],
  ]);
});

afterEach(async () => {
  await Promise.all(nodes.map((n) => n.close()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function addNode(name: string, over: Partial<NodeInfo> = {}): Promise<FakeNode> {
  const n = await startFakeNode(name, over, TOKEN);
  nodes.push(n);
  await new NodeRegistry(fleetDir).add({ name, url: n.url, token: TOKEN, labels: [] });
  return n;
}

const claude = () => providers.get("claude-cloud")!;
const codex = () => providers.get("codex-cloud")!;

function service(): FleetService {
  return new FleetService({
    dir: fleetDir,
    autoStart: false,
    pollMs: 60_000,
    clientTimeoutMs: 2000,
    localEndpoints: false,
    cloud: {
      settings: () => settings,
      availability: async () => Promise.all([...providers.values()].map((p) => p.detect())),
      provider: (id) => providers.get(id)!,
      bench: () => {},
      recordUtilization: () => {},
    },
  });
}

describe("cloud eligibility", () => {
  it("keeps secrets, deploys, GPUs, OS labels, big jobs and fancy docker on nodes", () => {
    expect(cloudIneligibility({ kind: "build" })).toBeUndefined();
    expect(cloudIneligibility({ kind: "deploy" })).toMatch(/deploy/);
    expect(cloudIneligibility({ kind: "build", secrets: ["X"] })).toMatch(/secrets/);
    expect(cloudIneligibility({ kind: "render", resources: { gpus: 1 } })).toMatch(/GPU/);
    expect(cloudIneligibility({ kind: "render", resources: { gpuMemoryGb: 8 } })).toMatch(/GPU/);
    expect(cloudIneligibility({ kind: "test", resources: { labels: ["windows"] } })).toMatch(
      /windows/,
    );
    expect(cloudIneligibility({ kind: "test", resources: { labels: ["macos"] } })).toBeTruthy();
    expect(cloudIneligibility({ kind: "test", resources: { cpus: 8 } })).toMatch(/cpus/);
    expect(cloudIneligibility({ kind: "test", resources: { memoryGb: 32 } })).toMatch(/memory/);
    expect(cloudIneligibility({ kind: "test", resources: { cpus: 4, memoryGb: 16 } })).toBe(
      undefined,
    );
    expect(cloudIneligibility({ kind: "test", docker: { image: "node:20" } })).toBeUndefined();
    expect(cloudIneligibility({ kind: "test", docker: { dockerfile: "Dockerfile" } })).toBe(
      undefined,
    );
    expect(cloudIneligibility({ kind: "render", artifactGlobs: ["out/*"] })).toMatch(/artifacts/);
    expect(
      cloudIneligibility({ kind: "render", artifactGlobs: ["out/*"] }, { pinned: true }),
    ).toBeUndefined();
    expect(cloudIneligibility({ kind: "build", hasPatch: true })).toMatch(/uncommitted/);
    expect(cloudIneligibility({ kind: "build", hasPatch: true, snapshot: "abc" })).toBeUndefined();
  });

  it("wraps docker jobs and plain env for the sandbox", () => {
    const cmd = cloudJobCommand({
      id: "f1",
      command: "npm test",
      subdir: "web",
      docker: { image: "node:20" },
      env: { CI: "1", "bad name": "x" },
    });
    expect(cmd).toContain("export CI='1'");
    expect(cmd).not.toContain("bad name");
    expect(cmd).toContain(
      `docker run --rm -v "$PWD":/work -w '/work/web' -e CI 'node:20' sh -c 'npm test'`,
    );
    expect(cloudJobCommand({ id: "f1", command: "make", subdir: "app" })).toBe("cd 'app' && make");
  });

  it("describes cloud capacity for fleet nodes", () => {
    expect(describeCloudCapacity({ id: "claude-cloud", available: true, detail: "ok" }, {})).toBe(
      "cloud: claude-cloud ready, 4 cpu/16 GB, overflow",
    );
    expect(
      describeCloudCapacity(
        { id: "codex-cloud", available: false, detail: "no environment", setupHint: "create one" },
        { when: "always" },
      ),
    ).toBe("cloud: codex-cloud unavailable — no environment (create one)");
  });
});

describe("fleet jobs on cloud", () => {
  it("runs on cloud when no nodes are paired, and only a verified result counts", async () => {
    const svc = service();
    const { job, messages } = await svc.run(repo, "build");
    expect(messages.join("\n")).toMatch(/runs in the cloud/);
    await svc.tick();
    let j = (await svc.get(job.id))!;
    expect(j).toMatchObject({ state: "preparing", node: "cloud:claude-cloud" });
    const req = claude().started[0]!;
    expect(req).toMatchObject({
      model: "claude-haiku-5-5",
      maxTurns: 4,
      source: { repoRoot: repo, sha: job.sha },
    });
    expect(req.prompt).toContain(req.approveCommand!);
    expect(req.disallowedTools).toEqual([
      "Edit",
      "Write",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "Agent",
    ]);
    expect(await svc.logs(job.id)).toMatch(/verified log tail, when the job finishes/);
    claude().finished = true;
    await svc.tick();
    j = (await svc.get(job.id))!;
    expect(j.state).toBe("passed");
    expect(claude().archived).toEqual(["claude-cloud-task-1"]);
    expect(await svc.logs(job.id)).toMatch(/verified log tail[\s\S]*building/);
    await expect(svc.downloadArtifacts(job.id)).rejects.toThrow(/stay in the cloud/);
  });

  it("reports a verified failure with its log lines", async () => {
    claude().outcome = "fail";
    const svc = service();
    const { job } = await svc.run(repo, "build");
    await svc.tick();
    claude().finished = true;
    await svc.tick();
    const j = (await svc.get(job.id))!;
    expect(j).toMatchObject({ state: "failed", exitCode: 1 });
    expect(j.summary).toMatch(/Error: boom/);
  });

  it("uses a node with room first and overflows to cloud only when nodes are busy", async () => {
    const node = await addNode("a", { slots: 1 });
    const svc = service();
    const first = (await svc.run(repo, "build")).job;
    await svc.tick();
    expect(node.requests.map((r) => r.id)).toEqual([first.id]);
    expect(claude().started).toHaveLength(0);
    node.info.slotsUsed = 1;
    const second = (await svc.run(repo, "build")).job;
    await svc.tick();
    expect((await svc.get(second.id))!.node).toBe("cloud:claude-cloud");
    expect(node.requests).toHaveLength(1);
  });

  it("never sends ineligible or manual-mode jobs to cloud unless pinned", async () => {
    await addNode("a", { slots: 1, slotsUsed: 1 });
    const svc = service();
    const secret = (await svc.run(repo, "secret")).job;
    const pics = (await svc.run(repo, "pics")).job;
    settings = { when: "manual" };
    const build = (await svc.run(repo, "build")).job;
    await svc.tick();
    // No deploy-labelled node: the existing rule fails it; cloud never takes secrets.
    expect((await svc.get(secret.id))!.state).toBe("error");
    for (const id of [pics.id, build.id]) {
      expect((await svc.get(id))!.state).toBe("queued");
    }
    expect(claude().started).toHaveLength(0);
    await expect(svc.run(repo, "pics", { node: "codex-cloud" })).rejects.toThrow(
      /Codex cloud can't report verified results; use claude-cloud/,
    );
    const pinned = await svc.run(repo, "pics", { node: "claude-cloud" });
    expect(pinned.messages.join("\n")).toMatch(/artifacts stay in the cloud session/);
    await svc.tick();
    expect((await svc.get(pinned.job.id))!.node).toBe("cloud:claude-cloud");
    expect(claude().started).toHaveLength(1);
    expect(codex().started).toHaveLength(0);
    await expect(svc.run(repo, "secret", { node: "cloud" })).rejects.toThrow(/secrets/);
  });

  it("requeues an unverified result once, to a node, and never to Codex", async () => {
    claude().outcome = "unverified";
    const node = await addNode("a", { slots: 1, slotsUsed: 1 });
    const svc = service();
    const { job } = await svc.run(repo, "build");
    await svc.tick();
    expect((await svc.get(job.id))!.node).toBe("cloud:claude-cloud");
    claude().finished = true;
    await svc.tick(); // unverified: back to the queue; codex is skipped, the node is still full
    let j = (await svc.get(job.id))!;
    expect(j.requeues?.[0]).toMatchObject({ from: "cloud:claude-cloud" });
    expect(j.requeues?.[0]?.reason).toMatch(/could not be verified/);
    expect(j).toMatchObject({ state: "queued", attempts: 2 });
    expect(codex().started).toHaveLength(0);
    node.info.slotsUsed = 0;
    await svc.tick();
    j = (await svc.get(job.id))!;
    expect(j.node).toBe("a");
    expect(node.requests[0]!.id).toBe(`${job.id}-2`);
  });

  it("errors when the only verifiable provider already failed and no node exists", async () => {
    claude().outcome = "unverified";
    const svc = service();
    const { job } = await svc.run(repo, "build");
    await svc.tick();
    claude().finished = true;
    await svc.tick();
    const j = (await svc.get(job.id))!;
    expect(j.state).toBe("error");
    expect(claude().started).toHaveLength(1);
    expect(codex().started).toHaveLength(0);
  });

  it("cancels a cloud job by interrupting and archiving the session", async () => {
    const svc = service();
    const { job } = await svc.run(repo, "build", { node: "claude-cloud" });
    await svc.tick();
    await svc.cancel(job.id);
    expect(claude().interrupted).toEqual(["claude-cloud-task-1"]);
    expect(claude().archived).toEqual(["claude-cloud-task-1"]);
    expect((await svc.get(job.id))!.state).toBe("cancelled");
  });

  it("starts the Docker daemon for docker jobs", async () => {
    fs.writeFileSync(
      path.join(repo, ".ezcoder", "fleet.json"),
      JSON.stringify({
        jobs: { pg: { kind: "test", command: "npm test", docker: { image: "node:20" } } },
      }),
    );
    git(repo, "commit", "-qam", "docker job");
    const svc = service();
    const { job } = await svc.run(repo, "pg");
    await svc.tick();
    const req = claude().started[0]!;
    expect(req.approveCommand).toContain("dockerd");
    expect(req.approveCommand).toContain("docker run --rm");
    claude().finished = true;
    await svc.tick();
    expect((await svc.get(job.id))!.state).toBe("passed");
  });

  it("never sends a cloud-only job (local source) to a node paired later", async () => {
    git(repo, "commit", "-q", "--allow-empty", "-m", "not pushed");
    settings = { enabled: false };
    const svc = service();
    await expect(svc.run(repo, "build")).rejects.toThrow(/no nodes paired/);
    settings = {};
    const { job } = await svc.run(repo, "build");
    expect(job.cloudOnly).toBe(true);
    const node = await addNode("a");
    claude().available = false;
    codex().available = false;
    await svc.tick();
    expect(node.requests).toHaveLength(0);
    const j = (await svc.get(job.id))!;
    expect(j.state).toBe("error");
    expect(j.summary).toMatch(/Push and run it again/);
  });

  it("lists cloud capacity next to nodes", async () => {
    const svc = service();
    expect(await svc.cloudLines()).toEqual([
      "cloud: claude-cloud ready, 4 cpu/16 GB, overflow",
      "cloud: codex-cloud connected; not used for jobs (can't report verified results)",
    ]);
    codex().available = false;
    expect((await svc.cloudLines())[1]).toBe(
      "cloud: codex-cloud unavailable — not signed in (sign in to codex-cloud)",
    );
  });
});
