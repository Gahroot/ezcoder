import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthStorage } from "@prestyj/core";
import type { Browser } from "playwright";
import { listCustomEndpoints } from "../local-endpoint-store.js";
import type { GateResult } from "../validation/service.js";
import { AgentNotificationQueue } from "../agent-notifications.js";
import { BrowserManager, type Chromium } from "../../tools/browser-session.js";
import { resolveBrowserWsEndpoint, selectFleetBrowser } from "./browser.js";
import { NodeRegistry } from "./registry.js";
import { FleetService, fleetJobNotification } from "./service.js";
import { attachFleetNotifications } from "./session-hook.js";
import { startFakeNode, type FakeNode } from "./__fixtures__/fake-node.js";
import type { NodeInfo } from "./protocol.js";

const TOKEN = "z".repeat(32);
let tmp: string;
let repo: string;
let fleetDir: string;
let nodes: FakeNode[];
let gateOk: boolean;
let gateCalls: string[];

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(rel: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ezf-svc-"));
  fleetDir = path.join(tmp, "fleet");
  const bare = path.join(tmp, "origin.git");
  git(tmp, "init", "-q", "--bare", "-b", "main", bare);
  repo = path.join(tmp, "proj");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "remote", "add", "origin", bare);
  write("package.json", JSON.stringify({ scripts: { build: "tsc" } }));
  write(
    ".ezcoder/fleet.json",
    JSON.stringify({
      jobs: {
        deploy: { kind: "deploy", command: "./deploy.sh", resources: { labels: ["deploy"] } },
      },
    }),
  );
  write(".gitignore", ".ezcoder/artifacts/\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "one");
  git(repo, "push", "-q", "origin", "main");
  nodes = [];
  gateOk = true;
  gateCalls = [];
});

afterEach(async () => {
  selectFleetBrowser(undefined);
  await Promise.all(nodes.map((n) => n.close()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function addNode(name: string, over: Partial<NodeInfo> = {}): Promise<FakeNode> {
  const n = await startFakeNode(name, over, TOKEN);
  nodes.push(n);
  await new NodeRegistry(fleetDir).add({ name, url: n.url, token: TOKEN, labels: [] });
  return n;
}

function service(): FleetService {
  return new FleetService({
    dir: fleetDir,
    autoStart: false,
    pollMs: 60_000,
    clientTimeoutMs: 2000,
    unreachableRequeueMinutes: 0,
    gate: async (_cwd, sha): Promise<GateResult> => {
      gateCalls.push(sha);
      return { sha, ok: gateOk, rows: [{ stage: "test", state: gateOk ? "passed" : "missing" }] };
    },
    localEndpoints: {
      settingsFile: path.join(tmp, "app.json"),
      auth: new AuthStorage(path.join(tmp, "auth.json")),
    },
  });
}

describe("FleetService jobs", () => {
  it.skipIf(process.platform === "win32")(
    "never writes downloaded artifacts through a symlink",
    async () => {
      const node = await addNode("my-pc");
      const svc = service();
      const { job } = await svc.run(repo, "build");
      await svc.tick();
      const outside = fs.mkdtempSync(path.join(tmp, "outside-"));
      const dir = path.join(repo, ".ezcoder", "artifacts", job.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.symlinkSync(outside, path.join(dir, "dist"));
      Object.assign(node.jobs.get(job.id)!, {
        state: "passed",
        exitCode: 0,
        artifacts: [{ path: "dist/app.js", bytes: 5 }],
      });
      node.artifacts.set(job.id, new Map([["dist/app.js", "hello"]]));
      await expect(svc.downloadArtifacts(job.id)).rejects.toThrow(/symlink/);
      expect(fs.existsSync(path.join(outside, "app.js"))).toBe(false);
    },
  );

  it("dispatches, polls to pass and downloads artifacts", async () => {
    const node = await addNode("my-pc");
    const svc = service();
    const q = new AgentNotificationQueue();
    const detach = attachFleetNotifications(() => repo, q, svc);
    const { job } = await svc.run(repo, "build");
    expect(job.state).toBe("queued");
    await svc.tick();
    const req = node.requests[0]!;
    expect(req).toMatchObject({
      id: job.id,
      kind: "build",
      source: { sha: git(repo, "rev-parse", "HEAD") },
    });
    expect((await svc.get(job.id))!.state).toBe("running");

    const st = node.jobs.get(job.id)!;
    Object.assign(st, {
      state: "passed",
      exitCode: 0,
      artifacts: [
        { path: "dist/app.js", bytes: 5 },
        { path: "../evil", bytes: 1 },
      ],
    });
    node.artifacts.set(job.id, new Map([["dist/app.js", "hello"]]));
    await svc.tick();
    const done = (await svc.get(job.id))!;
    expect(done.state).toBe("passed");
    const file = path.join(repo, ".ezcoder", "artifacts", job.id, "dist", "app.js");
    expect(fs.readFileSync(file, "utf8")).toBe("hello");
    expect(fs.existsSync(path.join(repo, ".ezcoder", "artifacts", "evil"))).toBe(false);
    expect(
      q
        .drain()
        .map((n) => n.text)
        .join(" "),
    ).toMatch(/Fleet job passed: build/);
    detach();
  });

  it("reports failures with log lines", async () => {
    const node = await addNode("my-pc");
    const svc = service();
    const { job } = await svc.run(repo, "build");
    await svc.tick();
    Object.assign(node.jobs.get(job.id)!, { state: "failed", exitCode: 2, logBytes: 30 });
    node.logs.set(job.id, "compiling\nError: boom in a.ts\n");
    await svc.tick();
    const j = (await svc.get(job.id))!;
    expect(j.state).toBe("failed");
    expect(j.summary).toMatch(/Error: boom/);
    expect(fleetJobNotification(j)).toMatchObject({ urgent: true, terminal: true });
    expect(await svc.logs(job.id)).toContain("boom");
  });

  it("requeues on node loss, away from the lost node", async () => {
    const a = await addNode("a");
    const b = await addNode("b", { load: 5 });
    const svc = service();
    const { job } = await svc.run(repo, "build");
    await svc.tick();
    expect(a.requests).toHaveLength(1);
    a.jobs.get(job.id)!.state = "lost";
    await svc.tick();
    // Requeued then dispatched again in the same pass, to b.
    const j = (await svc.get(job.id))!;
    expect(j.requeues).toHaveLength(1);
    expect(j.attempts).toBe(2);
    expect(j.node).toBe("b");
    expect(b.requests[0]!.id).toBe(`${job.id}-2`);
  });

  it("requeues when the node stays unreachable", async () => {
    const a = await addNode("a");
    await addNode("b", { load: 5 });
    const svc = service();
    const { job } = await svc.run(repo, "build");
    await svc.tick();
    await a.close();
    await svc.tick(); // first failure: remember when
    await new Promise((r) => setTimeout(r, 10));
    await svc.tick(); // past the (0 min) limit: moves
    const j = (await svc.get(job.id))!;
    expect(j.requeues?.[0]?.from).toBe("a");
    expect(j.node).toBe("b");
  });

  it("never requeues a deploy", async () => {
    const a = await addNode("a", { labels: ["deploy"] });
    await addNode("b", { labels: ["deploy"] });
    const svc = service();
    const { job } = await svc.run(repo, "deploy");
    await svc.tick();
    expect(gateCalls.length).toBeGreaterThanOrEqual(2); // at queue time and at dispatch
    const on = (await svc.get(job.id))!.node!;
    (on === "a" ? a : nodes[1]!).jobs.get(job.id)!.state = "lost";
    await svc.tick();
    const j = (await svc.get(job.id))!;
    expect(j.state).toBe("error");
    expect(j.summary).toMatch(/not retried automatically/);
  });

  it("blocks a deploy until validation passed at the exact sha", async () => {
    await addNode("a", { labels: ["deploy"] });
    gateOk = false;
    const svc = service();
    await expect(svc.run(repo, "deploy")).rejects.toThrow(/deploy blocked/);
    expect(gateCalls).toEqual([git(repo, "rev-parse", "HEAD")]);
    await expect(svc.run(repo, "deploy", { includeUncommitted: true })).rejects.toThrow(
      /exact pushed/,
    );
  });

  it("needs the commit on origin unless local changes go as a patch", async () => {
    const node = await addNode("my-pc");
    const pushed = git(repo, "rev-parse", "HEAD");
    write("src/new.ts", "export const x = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "local");
    write("src/untracked.ts", "y\n");
    const svc = service();
    await expect(svc.run(repo, "build")).rejects.toThrow(/push first/);
    const { job } = await svc.run(repo, "build", { includeUncommitted: true });
    expect(job).toMatchObject({ sha: pushed, hasPatch: true });
    await svc.tick();
    const patch = Buffer.from(node.requests[0]!.source!.patch!, "base64").toString();
    expect(patch).toContain("src/new.ts");
    expect(patch).toContain("src/untracked.ts");
    // The user's index is untouched.
    expect(git(repo, "status", "--porcelain")).toContain("?? src/untracked.ts");
  });

  it("errors at once when nothing fits, and cancels on the node", async () => {
    const node = await addNode("my-pc");
    const svc = service();
    const { job } = await svc.run(repo, "deploy"); // needs label deploy
    await svc.tick();
    expect((await svc.get(job.id))!.state).toBe("error");
    const r = await svc.run(repo, "build");
    await svc.tick();
    await svc.cancel(r.job.id);
    expect(node.cancelled).toEqual([r.job.id]);
    expect((await svc.get(r.job.id))!.state).toBe("cancelled");
  });
});

describe("FleetService services", () => {
  it("registers an inference endpoint and removes it on down", async () => {
    await addNode("my-pc");
    const gpu = await addNode("gpu-box", {
      gpus: [{ name: "RTX", memoryGb: 24, vendor: "nvidia" }],
    });
    const svc = service();
    const opts = { settingsFile: path.join(tmp, "app.json") };
    const r = await svc.serviceUp(repo, "llm");
    expect(r.service.node).toBe("gpu-box");
    expect(gpu.serviceRequests[0]).toMatchObject({ kind: "inference", docker: { gpu: true } });
    const eps = await listCustomEndpoints(opts);
    expect(eps).toHaveLength(1);
    expect(eps[0]).toMatchObject({
      label: "fleet:gpu-box/llm",
      baseUrl: "http://gpu-box.tailnet.test:41000/v1",
    });
    expect((await svc.serviceUp(repo, "llm")).reused).toBe(true);
    await svc.serviceDown("llm", repo);
    expect(await listCustomEndpoints(opts)).toEqual([]);
    expect(gpu.services.size).toBe(0);
  });

  it("execs in a devenv started from local work", async () => {
    const node = await addNode("my-pc");
    const svc = service();
    const r = await svc.serviceUp(repo, "dev");
    expect(node.serviceRequests[0]!.source?.sha).toBe(git(repo, "rev-parse", "HEAD"));
    expect(r.service.kind).toBe("devenv");
    expect((await svc.serviceExec("dev", "ls", { cwd: repo })).output).toBe("ran: ls");
    await expect(svc.serviceExec("nope", "ls")).rejects.toThrow(/no running/);
  });

  it("resolves the browser ws endpoint and BrowserManager connects to it", async () => {
    await addNode("my-pc");
    const svc = service();
    const r = await svc.serviceUp(repo, "browser");
    expect(await resolveBrowserWsEndpoint({ env: {}, dir: fleetDir })).toBeUndefined();
    selectFleetBrowser(r.service.id);
    const ws = await resolveBrowserWsEndpoint({ env: {}, dir: fleetDir });
    expect(ws).toBe("ws://my-pc.tailnet.test:41000");
    expect(
      await resolveBrowserWsEndpoint({ env: { EZCODER_BROWSER_WS: "ws://x:1" }, dir: fleetDir }),
    ).toBe("ws://x:1");
    selectFleetBrowser("my-pc/browser");
    expect(await resolveBrowserWsEndpoint({ env: {}, dir: fleetDir })).toBe(ws);

    const calls: string[] = [];
    const page = { isClosed: () => false, on: () => page };
    const context = {
      addInitScript: async () => {},
      on: () => context,
      newPage: async () => page,
      pages: () => [page],
    };
    const browser = { on: () => browser, newContext: async () => context, close: async () => {} };
    const chromium: Chromium = {
      launch: async () => {
        calls.push("launch");
        return browser as unknown as Browser;
      },
      connect: async (endpoint) => {
        calls.push(`connect ${endpoint}`);
        return browser as unknown as Browser;
      },
    };
    const remote = new BrowserManager({ loadChromium: async () => chromium, wsEndpoint: () => ws });
    await remote.page();
    expect(remote.remoteEndpoint).toBe(ws);
    const local = new BrowserManager({ loadChromium: async () => chromium });
    await local.page();
    expect(calls).toEqual([`connect ${ws}`, "launch"]);
  });
});
