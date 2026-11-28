import { afterEach, describe, expect, it } from "vitest";
import { createPairCode } from "./config.js";
import { PAIR_WINDOW_MS } from "./pair-code-route.js";
import type { NodeServer } from "./server.js";
import { startTestServer, tempDir } from "./__fixtures__/server.js";

let servers: NodeServer[] = [];
afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
});

const post = (s: NodeServer, code: unknown) =>
  fetch(s.url + "/v1/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });

describe("POST /v1/pair", () => {
  it("trades a live code for the pairing string once, without a token", async () => {
    const dir = tempDir();
    const s = await startTestServer(dir);
    servers.push(s);
    const code = createPairCode(dir);
    const res = await post(s, code.toLowerCase());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pairing: string };
    expect(body.pairing).toMatch(
      /^ezfleet:\/\/test-node@my-pc\.example\.ts\.net:\d+#secret-token-123$/,
    );
    const again = await post(s, code);
    expect(again.status).toBe(403);
    expect(await again.json()).toMatchObject({ code: "bad_code" });
  });

  it("rate-limits after 5 wrong codes in 10 minutes, then recovers", async () => {
    const dir = tempDir();
    let now = 1_000_000;
    const s = await startTestServer(dir, {}, { now: () => now });
    servers.push(s);
    const code = createPairCode(dir, now);
    for (let i = 0; i < 5; i++) expect((await post(s, "AAAA-AAAA")).status).toBe(403);
    const limited = await post(s, code);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(await limited.json()).toMatchObject({ code: "rate_limited" });
    now += PAIR_WINDOW_MS - 1000; // the code itself lasts exactly the window
    expect((await post(s, code)).status).toBe(429);
    now += 2000;
    expect((await post(s, code)).status).toBe(403); // expired by now
    const fresh = createPairCode(dir, now);
    expect((await post(s, fresh)).status).toBe(200);
  });

  it("rejects bodies without a code", async () => {
    const s = await startTestServer(tempDir());
    servers.push(s);
    const res = await fetch(s.url + "/v1/pair", { method: "POST", body: "nope" });
    expect(res.status).toBe(403);
  });
});
