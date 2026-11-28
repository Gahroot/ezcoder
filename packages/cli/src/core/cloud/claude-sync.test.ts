import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  ClaudeCloudProvider,
  claudeSyncChunkCommands,
  claudeSyncPrepareCommand,
  decodeSyncPayload,
  MAX_SYNC_B64_BYTES,
  parseSyncChunk,
  parseSyncOutput,
  SYNC_CHUNK_CHARS,
} from "./claude.js";
import type { CloudTaskHandle } from "./types.js";

const BASE = "a".repeat(40);
const handle: CloudTaskHandle = {
  provider: "claude-cloud",
  id: "session_1",
  url: "https://claude.ai/code/session_1",
  baseCommit: BASE,
};

/** What the sandbox prints for a packed diff (mirrors the shell commands). */
function sandbox(patch: string) {
  const b64 = patch ? gzipSync(Buffer.from(patch)).toString("base64") : "";
  const sha = createHash("sha256").update(b64).digest("hex");
  const prepare = claudeSyncPrepareCommand(BASE);
  const chunks = claudeSyncChunkCommands(b64.length);
  return {
    b64,
    run(command: string): string | undefined {
      if (command === prepare) {
        return b64
          ? `EZSYNC ${sha} ${b64.length}\n${b64.slice(0, SYNC_CHUNK_CHARS)}\nEZSYNC-END\n`
          : "EZSYNC EMPTY\n";
      }
      const k = chunks.indexOf(command);
      if (k < 0) return undefined;
      return `EZSYNC-PART ${k + 1}\n${b64.slice(k * SYNC_CHUNK_CHARS, (k + 1) * SYNC_CHUNK_CHARS)}\nEZSYNC-END\n`;
    },
  };
}

/**
 * A fake session: each user message is a turn in which the "agent" runs every
 * fenced command (through `run`) and the harness records it.
 */
function fakeSession(
  run: (command: string) => string | undefined,
  opts: { initialStatus?: string } = {},
) {
  const events: Record<string, unknown>[] = [
    { id: "e0", type: "result", num_turns: 1, is_error: false },
  ];
  let status = opts.initialStatus ?? "idle";
  const sent: string[] = [];
  let n = 0;
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.pathname === "/api/oauth/profile") {
      return json({
        account: { email: "me@x", has_claude_max: true },
        organization: { uuid: "o" },
      });
    }
    if (url.pathname === "/v1/environment_providers") {
      return json({
        environments: [
          { kind: "anthropic_cloud", environment_id: "env", name: "Default", state: "active" },
        ],
      });
    }
    if (url.pathname === "/v1/sessions/session_1") return json({ session_status: status });
    if (url.pathname === "/v1/sessions/session_1/events" && init.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        events: { type: string; message?: { content: string } }[];
      };
      for (const e of body.events) {
        if (e.type !== "user" || !e.message) continue;
        sent.push(e.message.content);
        const commands = [...e.message.content.matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
        for (const command of commands) {
          const id = `tu${++n}`;
          events.push({
            id: `e${events.length}`,
            type: "assistant",
            message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
          });
          events.push({
            id: `e${events.length}`,
            type: "user",
            message: {
              content: [
                { type: "tool_result", tool_use_id: id, content: run(command) ?? "not found" },
              ],
            },
          });
        }
        events.push({ id: `e${events.length}`, type: "result", is_error: false });
      }
      return json({});
    }
    if (url.pathname === "/v1/sessions/session_1/events") {
      const after = url.searchParams.get("after_id");
      const from = after ? events.findIndex((e) => e.id === after) + 1 : 0;
      const data = events.slice(from);
      return json({ data, has_more: false, last_id: data.at(-1)?.id ?? after });
    }
    return new Response("not mocked", { status: 500 });
  }) as typeof fetch;
  const provider = new ClaudeCloudProvider({
    fetch: fetchImpl,
    auth: { resolveCredentials: async () => ({ accessToken: "tok" }) },
    settings: () => ({}),
    recordUtilization: () => {},
    benchProvider: () => {},
    sleep: async () => {},
  });
  return {
    provider,
    sent,
    setStatus: (s: string) => {
      status = s;
    },
  };
}

const PATCH =
  "diff --git a/b.txt b/b.txt\nnew file mode 100644\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1 @@\n+cloud\n";

describe("Claude cloud edit sync: parsing", () => {
  it("parses the header, the empty marker and chunks", () => {
    const s = sandbox(PATCH);
    const parsed = parseSyncOutput(s.run(claudeSyncPrepareCommand(BASE))!);
    expect(parsed).toMatchObject({ empty: false, length: s.b64.length, data: s.b64 });
    expect(parseSyncOutput("noise\nEZSYNC EMPTY\n")).toEqual({ empty: true });
    expect(parseSyncChunk("EZSYNC-PART 2\nabc\nEZSYNC-END\n")).toBe("abc");
    expect(() => parseSyncChunk("EZSYNC-PART 2\nabc")).toThrow(/cut off/);
    expect(() => parseSyncOutput("<persisted-output>\npreview\n</persisted-output>")).toThrow(
      /cut off by the sandbox/,
    );
    expect(() => parseSyncOutput("fatal: bad revision")).toThrow(/printed no result/);
  });

  it("rejects a payload whose hash or length doesn't match", () => {
    const s = sandbox(PATCH);
    const sha = createHash("sha256").update(s.b64).digest("hex");
    expect(decodeSyncPayload(s.b64, sha, s.b64.length).toString()).toBe(PATCH);
    expect(() => decodeSyncPayload(s.b64.slice(1), sha, s.b64.length)).toThrow(/checksum/);
    const tampered = (s.b64[0] === "A" ? "B" : "A") + s.b64.slice(1);
    expect(() => decodeSyncPayload(tampered, sha, s.b64.length)).toThrow(/checksum/);
  });

  it("only ever builds commands from a commit hash", () => {
    expect(claudeSyncPrepareCommand(BASE)).toContain(`git diff --cached --binary ${BASE}`);
    expect(claudeSyncChunkCommands(SYNC_CHUNK_CHARS * 2 + 1)).toHaveLength(3);
  });
});

describe("ClaudeCloudProvider.diff", () => {
  it("brings a small diff back in one exact-command turn", async () => {
    const s = sandbox(PATCH);
    const f = fakeSession(s.run);
    expect((await f.provider.diff(handle)).toString()).toBe(PATCH);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toContain(claudeSyncPrepareCommand(BASE));
    expect(f.sent[0]!.length).toBeLessThan(1_200);
  });

  it("accepts a command the model trimmed but whose core is intact", async () => {
    const s = sandbox(PATCH);
    const prepare = claudeSyncPrepareCommand(BASE);
    const f = fakeSession((c) => (c === `cd . && ${prepare}` ? s.run(prepare) : undefined));
    const original = f.provider.send.bind(f.provider);
    f.provider.send = (h, m) => original(h, m.replace(prepare, `cd . && ${prepare}`));
    expect((await f.provider.diff(handle)).toString()).toBe(PATCH);
  });

  it("returns empty when nothing changed", async () => {
    const f = fakeSession(sandbox("").run);
    expect((await f.provider.diff(handle)).length).toBe(0);
    expect(f.sent).toHaveLength(1);
  });

  it("reassembles a large diff from numbered chunks in a second turn", async () => {
    // Incompressible content so the packed diff spans several chunks.
    const noise = randomBytes(60_000).toString("base64");
    const big = `${PATCH}+${noise}\n`;
    const s = sandbox(big);
    expect(s.b64.length).toBeGreaterThan(SYNC_CHUNK_CHARS * 2);
    const f = fakeSession(s.run);
    expect((await f.provider.diff(handle)).toString()).toBe(big);
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toContain("EZSYNC-PART 3");
  });

  it("fails on a checksum mismatch, a changed command, a busy session or a huge diff", async () => {
    const s = sandbox(PATCH);
    const corrupt = fakeSession((c) => s.run(c)?.replace(/\n[A-Za-z0-9+/]/, "\nA"));
    await expect(corrupt.provider.diff(handle)).rejects.toThrow(/checksum/);

    const disobedient = fakeSession(s.run);
    const original = disobedient.provider.send.bind(disobedient.provider);
    disobedient.provider.send = (h, m) =>
      original(h, m.replace("git diff --cached --binary", "git diff --binary"));
    await expect(disobedient.provider.diff(handle)).rejects.toThrow(/did not run/);
    for (const [from, to] of [
      ["git add -A", "git add ."],
      ["git read-tree HEAD && ", ""],
    ]) {
      const altered = fakeSession(s.run);
      const send = altered.provider.send.bind(altered.provider);
      altered.provider.send = (h, m) => send(h, m.replace(from!, to!));
      await expect(altered.provider.diff(handle)).rejects.toThrow(/did not run/);
    }

    const busy = fakeSession(s.run, { initialStatus: "running" });
    await expect(busy.provider.diff(handle)).rejects.toThrow(/not idle/);
    expect(busy.sent).toHaveLength(0);

    const huge = fakeSession(
      () => `EZSYNC ${"0".repeat(64)} ${MAX_SYNC_B64_BYTES + 1}\nxx\nEZSYNC-END\n`,
    );
    await expect(huge.provider.diff(handle)).rejects.toThrow(/stay in the session: https/);
    expect(huge.sent).toHaveLength(1);
  });
});
