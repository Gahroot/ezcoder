import { describe, expect, it } from "vitest";
import {
  compareVersions,
  FleetClient,
  FleetClientError,
  normalizePairCode,
  protocolProblem,
  safeArtifactPath,
} from "./client.js";
import { stripUrlCredentials } from "./git.js";
import { FLEET_PROTOCOL, PROTOCOL_HEADER, VERSION_HEADER } from "./protocol.js";
import { parsePairing } from "./registry.js";

const TOKEN = "a".repeat(32);
const FP = "ab".repeat(32);

describe("safeArtifactPath (R7)", () => {
  it("keeps plain relative paths", () => {
    expect(safeArtifactPath("dist/app.js")).toBe("dist/app.js");
    expect(safeArtifactPath("./a\\b.txt")).toBe("a/b.txt");
  });
  it("refuses .git segments, traversal and absolute paths", () => {
    for (const bad of [
      ".git/config",
      "x/.git/hooks/pre-commit",
      "x/.GIT/hooks",
      ".git./config",
      "../evil",
      "a/../../b",
      "/etc/passwd",
      "C:/Windows/x",
      "a/b:stream",
      "",
    ]) {
      expect(safeArtifactPath(bad), bad).toBeUndefined();
    }
    expect(safeArtifactPath("x/.github/workflows/ci.yml")).toBe("x/.github/workflows/ci.yml");
  });
});

describe("TLS pairing strings (X10)", () => {
  it("parses the fingerprint and uses https", () => {
    const p = parsePairing(`ezfleets://my-pc@host.example:7400#${TOKEN};fp=${FP.toUpperCase()}`);
    expect(p).toMatchObject({ name: "my-pc", url: "https://host.example:7400", fingerprint: FP });
  });
  it("accepts colon-separated fingerprints", () => {
    const colon = FP.match(/../g)!.join(":");
    expect(parsePairing(`ezfleets://my-pc@h#${TOKEN};fp=${colon}`).fingerprint).toBe(FP);
  });
  it("refuses TLS without a valid fingerprint, and fp on plain http", () => {
    expect(() => parsePairing(`ezfleets://my-pc@h:1#${TOKEN}`)).toThrow(/fingerprint/);
    expect(() => parsePairing(`ezfleets://my-pc@h:1#${TOKEN};fp=abc`)).toThrow(/fingerprint/);
    expect(() => parsePairing(`ezfleet://my-pc@h:1#${TOKEN};fp=${FP}`)).toThrow(/ezfleets/);
  });
});

describe("protocol handshake (S3)", () => {
  it("accepts a node in range and names the side to update otherwise", () => {
    expect(protocolProblem("pc", { protocol: FLEET_PROTOCOL })).toBeUndefined();
    const old = protocolProblem("pc", { protocol: 1 });
    expect(old?.update).toBe("node");
    expect(old?.message).toContain("update the node: on pc run `npm i -g @prestyj/cli@latest`");
    const newer = protocolProblem("pc", {
      protocol: FLEET_PROTOCOL + 1,
      minProtocol: FLEET_PROTOCOL + 1,
    });
    expect(newer?.update).toBe("controller");
    expect(newer?.message).toContain("update EZ Coder on this machine");
    // A newer node that still accepts our protocol is fine.
    expect(
      protocolProblem("pc", { protocol: FLEET_PROTOCOL + 1, minProtocol: FLEET_PROTOCOL }),
    ).toBeUndefined();
  });

  it("sends the protocol headers and turns 426 into an incompatible error", async () => {
    const seen: Record<string, string>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return new Response(
        JSON.stringify({
          error: "too old",
          code: "protocol_mismatch",
          update: "controller",
          nodeProtocol: FLEET_PROTOCOL + 1,
        }),
        { status: 426 },
      );
    }) as unknown as typeof fetch;
    const c = new FleetClient("pc", "http://x:1", TOKEN, { fetch: fetchImpl });
    const err = await c.info().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FleetClientError);
    expect(err).toMatchObject({ code: "incompatible", update: "controller" });
    expect((err as Error).message).toContain("update EZ Coder on this machine");
    expect(seen[0]![PROTOCOL_HEADER]).toBe(String(FLEET_PROTOCOL));
    expect(seen[0]![VERSION_HEADER]).toMatch(/\d+\.\d+/);
  });

  it("maps 409 to exists and 429 to busy", async () => {
    const reply = (status: number, body: object) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const exists = new FleetClient("pc", "http://x:1", TOKEN, {
      fetch: reply(409, { error: "has creds", code: "exists" }),
    });
    await expect(exists.shareAuth({ credentials: {} })).rejects.toMatchObject({ code: "exists" });
    const busy = new FleetClient("pc", "http://x:1", TOKEN, {
      fetch: reply(429, { error: "no free slot" }),
    });
    await expect(busy.info()).rejects.toMatchObject({ code: "busy" });
  });
});

describe("helpers", () => {
  it("compares versions", () => {
    expect(compareVersions("1.2.10", "1.2.9")).toBe(1);
    expect(compareVersions("1.2.0", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.0-beta", "1.2.0")).toBe(-1);
    expect(compareVersions("v0.9", "1.0.0")).toBe(-1);
  });
  it("normalises pairing codes", () => {
    expect(normalizePairCode("k7qm2xpa")).toBe("K7QM-2XPA");
    expect(normalizePairCode("K7QM-2XP")).toBeUndefined();
  });
});

describe("stripUrlCredentials (X7)", () => {
  it("drops user and token from https remotes", () => {
    expect(stripUrlCredentials(`https://x-access-token:${TOKEN}@github.com/o/r.git`)).toBe(
      "https://github.com/o/r.git",
    );
    expect(stripUrlCredentials("https://user@gitlab.com/o/r")).toBe("https://gitlab.com/o/r");
  });
  it("keeps ssh usernames and plain URLs", () => {
    expect(stripUrlCredentials("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
    expect(stripUrlCredentials("ssh://git:pw@host/o/r")).toBe("ssh://git@host/o/r");
    expect(stripUrlCredentials("https://github.com/o/r")).toBe("https://github.com/o/r");
  });
});
