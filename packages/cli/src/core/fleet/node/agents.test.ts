import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { AgentDiff, AgentFrame } from "../protocol.js";
import {
  makeRepo,
  sh,
  startTestNode,
  TEST_TOKEN,
  type TestNode,
} from "../__fixtures__/test-node.js";
import { safeAgentEnv } from "./agents.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tmp(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ez-fleet-agents-")));
  cleanups.push(() =>
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  return dir;
}

async function node(options: Parameters<typeof startTestNode>[1] = {}): Promise<TestNode> {
  const n = await startTestNode(path.join(tmp(), "data"), options);
  cleanups.push(() => n.close());
  return n;
}

const auth = { authorization: `Bearer ${TEST_TOKEN}` };

async function api<T>(n: TestNode, method: string, route: string, body?: unknown) {
  const res = await fetch(`${n.url}${route}`, {
    method,
    headers: { ...auth, "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as T };
}

/** A WS client that collects stdout lines and frames. */
async function attach(n: TestNode, id: string) {
  const ws = new WebSocket(`${n.url.replace("http", "ws")}/v1/agents/${id}/attach`, {
    headers: auth,
  });
  let resumed = "";
  ws.once("upgrade", (res) => (resumed = String(res.headers["x-ezcoder-agent-resumed"])));
  const frames: AgentFrame[] = [];
  const lines: Record<string, unknown>[] = [];
  const waiters: Array<() => void> = [];
  ws.on("message", (raw) => {
    const frame = JSON.parse(raw.toString()) as AgentFrame;
    frames.push(frame);
    if (frame.t === "stdout") {
      for (const line of frame.data.split("\n").filter(Boolean)) lines.push(JSON.parse(line));
    }
    for (const w of waiters.splice(0)) w();
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const until = async (test: () => boolean, ms = 5_000) => {
    const deadline = Date.now() + ms;
    while (!test()) {
      if (Date.now() > deadline) throw new Error(`timed out; frames: ${JSON.stringify(frames)}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  const send = (command: Record<string, unknown>) =>
    ws.send(JSON.stringify({ t: "stdin", data: `${JSON.stringify(command)}\n` }));
  const close = () =>
    new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });
  return { ws, frames, lines, until, send, close, resumed: () => resumed };
}

async function createAgent(n: TestNode, id: string, extra: Record<string, unknown> = {}) {
  const repo = makeRepo(tmp());
  const res = await api<{ state: string; cwd: string }>(n, "POST", "/v1/agents", {
    id,
    project: "you/repo",
    source: { git: `file://${repo.origin}`, sha: repo.sha },
    ...extra,
  });
  return { repo, res };
}

describe("agents route module", () => {
  it("prepares a workspace, takes a slot, and returns 429 when full", async () => {
    const n = await node({ slots: 1 });
    const { res } = await createAgent(n, "a1");
    expect(res.status).toBe(201);
    expect(res.body.state).toBe("ready");
    expect(fs.existsSync(path.join(res.body.cwd, "a.txt"))).toBe(true);
    expect(n.slotsUsed()).toBe(1);
    expect((await createAgent(n, "a2")).res.status).toBe(429);
    expect(n.module.agents?.().map((a) => a.id)).toEqual(["a1"]);
  });

  it("filters credentials out of the requested env", () => {
    expect(
      safeAgentEnv({
        FOO: "1",
        SECRET_TOKEN: "x",
        OPENAI_API_KEY: "k",
        PATH: "/x",
        NODE_OPTIONS: "-r",
      }),
    ).toEqual({ FOO: "1" });
  });

  it("bridges stdio, runs in the node workspace, and buffers output across a re-attach", async () => {
    const n = await node();
    const { res } = await createAgent(n, "a1", { env: { SECRET_TOKEN: "leak", EXTRA: "1" } });
    const first = await attach(n, "a1");
    expect(first.resumed()).toBe("0");
    first.send({
      request_id: "r1",
      command: "initialize",
      options: {
        cwd: "/controller/path",
        sessionRootDir: "/controller/sessions",
        additionalRoots: ["/x"],
      },
    });
    await first.until(() => first.lines.some((l) => l.request_id === "r1"));
    const init = first.lines.find((l) => l.request_id === "r1")!;
    expect(init.cwd_seen).toBe(res.body.cwd);
    expect(init.process_cwd).toBe(res.body.cwd);
    expect(init.had_roots).toBe(false);
    expect(init.leaked).toBeNull();
    expect(String(init.child_session_path)).toContain(n.dataDir);

    // A held turn completes while nobody is attached: its output is buffered.
    first.send({ request_id: "r2", command: "start", task: "hold" });
    await first.until(() => first.lines.some((l) => l.request_id === "r2"));
    first.send({ request_id: "r3", command: "queue_message", message: "go" });
    await first.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(n.module.agents?.()[0]?.state).toBe("running");

    const second = await attach(n, "a1");
    expect(second.resumed()).toBe("1");
    await second.until(() => second.lines.some((l) => l.type === "turn_complete"));
    expect(second.lines.find((l) => l.type === "turn_complete")?.output).toBe("done 1: hold");

    second.send({ request_id: "r4", command: "shutdown" });
    await second.until(() => second.frames.some((f) => f.t === "exit"));
    expect(second.frames.find((f) => f.t === "exit")).toMatchObject({ code: 0 });
  });

  it("delivers an exit that happened while detached on the next attach", async () => {
    const n = await node();
    await createAgent(n, "a1");
    const first = await attach(n, "a1");
    first.send({ request_id: "r1", command: "initialize", options: { sessionRootDir: "/x" } });
    await first.until(() => first.lines.length > 0);
    await first.close();
    // Ask the worker to exit through a fresh socket that is dropped at once.
    const killer = await attach(n, "a1");
    killer.send({ request_id: "r2", command: "shutdown" });
    await killer.until(() => killer.lines.some((l) => l.request_id === "r2"));
    killer.ws.terminate();
    await new Promise((r) => setTimeout(r, 300));
    const again = await attach(n, "a1");
    expect(again.resumed()).toBe("1");
    await again.until(() => again.frames.some((f) => f.t === "exit"));
  });

  it("diffs edits against the base, including new files, and DELETE cleans up", async () => {
    const n = await node();
    const { res, repo } = await createAgent(n, "a1");
    fs.writeFileSync(path.join(res.body.cwd, "a.txt"), "changed\n");
    fs.mkdirSync(path.join(res.body.cwd, "new"));
    fs.writeFileSync(path.join(res.body.cwd, "new", "n.bin"), Buffer.from([0, 1, 2, 255]));
    const diff = await api<AgentDiff>(n, "GET", "/v1/agents/a1/diff");
    expect(diff.status).toBe(200);
    expect(diff.body.base).toBe(repo.sha);
    expect(diff.body.files.sort()).toEqual(["a.txt", "new/n.bin"]);
    const patch = Buffer.from(diff.body.patch, "base64").toString("utf-8");
    expect(patch).toContain("GIT binary patch");
    // The patch applies on the original base.
    fs.writeFileSync(path.join(n.dataDir, "p.patch"), Buffer.from(diff.body.patch, "base64"));
    sh(repo.local, "apply", "--binary", path.join(n.dataDir, "p.patch"));
    expect(fs.readFileSync(path.join(repo.local, "new", "n.bin"))).toEqual(
      Buffer.from([0, 1, 2, 255]),
    );

    const del = await api<{ id: string }>(n, "DELETE", "/v1/agents/a1");
    expect(del.status).toBe(200);
    expect(fs.existsSync(res.body.cwd)).toBe(false);
    expect(n.slotsUsed()).toBe(0);
    expect((await api(n, "GET", "/v1/agents/a1/diff")).status).toBe(404);
  });

  it("removes an abandoned agent after the detach grace period", async () => {
    const n = await node({ graceMs: 200 });
    const { res } = await createAgent(n, "a1");
    const client = await attach(n, "a1");
    await client.close();
    await new Promise((r) => setTimeout(r, 600));
    expect(n.module.agents?.()).toEqual([]);
    expect(fs.existsSync(res.body.cwd)).toBe(false);
    expect(n.slotsUsed()).toBe(0);
  });
});
