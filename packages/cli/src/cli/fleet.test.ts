// `ezcoder fleet` controller commands and the machines facade, against fake nodes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { discoverNodes } from "../core/fleet/discovery.js";
import {
  addMachine,
  fleetCapacity,
  listMachines,
  removeMachine,
  rotateMachineToken,
  shareAuth,
} from "../core/fleet/machines.js";
import { NodeRegistry } from "../core/fleet/registry.js";
import { FleetService } from "../core/fleet/service.js";
import { startFakeNode, type FakeNode } from "../core/fleet/__fixtures__/fake-node.js";
import type { NodeInfo } from "../core/fleet/protocol.js";
import type { Exec } from "../core/validation/types.js";
import { readPairingInput, runFleet } from "./fleet.js";

const TOKEN = "q".repeat(32);
let tmp: string;
let fleetDir: string;
let nodes: FakeNode[];
let lines: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ezf-cli-"));
  fleetDir = path.join(tmp, "fleet");
  nodes = [];
  lines = [];
  process.exitCode = undefined;
});

afterEach(async () => {
  await Promise.all(nodes.map((n) => n.close().catch(() => {})));
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = undefined;
});

async function fake(name: string, over: Partial<NodeInfo> = {}): Promise<FakeNode> {
  const n = await startFakeNode(name, over, TOKEN);
  nodes.push(n);
  return n;
}

function svc(): FleetService {
  return new FleetService({
    dir: fleetDir,
    validationDir: path.join(tmp, "validation"),
    autoStart: false,
    clientTimeoutMs: 1500,
    cloud: false,
    localEndpoints: false,
  });
}

function fleet(argv: string[], s = svc(), stdin?: Readable) {
  return runFleet(argv, {
    svc: s,
    out: (l) => lines.push(l),
    ...(stdin ? { stdin } : {}),
    add: { client: { timeoutMs: 1500 } },
  });
}

const output = () => lines.join("\n");

describe("fleet add (S2, S5, S9)", () => {
  it("pairs a reachable node and prints its doctor report", async () => {
    const n = await fake("pc");
    n.doctor.checks.push({ id: "gpu", status: "fail", detail: "no GPU", fix: "install drivers" });
    n.doctor.ok = false;
    await fleet(["add", n.pairing()]);
    expect(output()).toContain("Paired pc");
    expect(output()).toMatch(/FAIL gpu: no GPU — fix: install drivers/);
    expect(await new NodeRegistry(fleetDir).get("pc")).toBeDefined();
  });

  it("refuses an unreachable node unless --offline", async () => {
    const pairing = `ezfleet://gone@127.0.0.1:1#${TOKEN}`;
    await expect(fleet(["add", pairing])).rejects.toThrow(
      /not pairing gone: .*unreachable.*--offline/,
    );
    expect(await new NodeRegistry(fleetDir).get("gone")).toBeUndefined();
    await fleet(["add", pairing, "--offline"]);
    expect(output()).toContain("without checking it (--offline)");
    expect(await new NodeRegistry(fleetDir).get("gone")).toBeDefined();
  });

  it("refuses a rejected token", async () => {
    const n = await fake("pc");
    const bad = n.pairing().replace(TOKEN, "w".repeat(32));
    await expect(fleet(["add", bad])).rejects.toThrow(/rejected our token.*--offline/);
  });

  it("refuses a node with an incompatible protocol, naming the side to update", async () => {
    const n = await fake("old", { protocol: 1, minProtocol: 1 });
    await expect(fleet(["add", n.pairing()])).rejects.toThrow(
      /update the node: on old run `npm i -g @prestyj\/cli@latest`/,
    );
  });

  it("reads the pairing string from piped stdin when no argument is given", async () => {
    const n = await fake("pc");
    await fleet(["add"], svc(), Readable.from([`${n.pairing()}\n`]));
    expect(output()).toContain("Paired pc");
  });

  it("reads a hidden line on a TTY without echoing it", async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = true;
    const echoed: string[] = [];
    const sink = new PassThrough();
    sink.on("data", (c: Buffer) => echoed.push(String(c)));
    const p = readPairingInput(input, sink);
    input.write("ezfleet://pc@h#secret-token-value-123\n");
    expect(await p).toBe("ezfleet://pc@h#secret-token-value-123");
    expect(echoed.join("")).not.toContain("secret-token");
  });

  it("pairs with a short code at --host", async () => {
    const n = await fake("pc");
    n.pairCode = "K7QM-2XPA";
    await fleet(["add", "--code", "k7qm2xpa", "--host", n.url]);
    expect(output()).toContain("Paired pc");
    // Single use.
    await expect(
      addMachine("K7QM-2XPA", { svc: svc(), host: n.url, client: { timeoutMs: 1500 } }),
    ).rejects.toThrow(/wrong, expired/);
  });

  it("finds the node for a code on the tailnet when no host is given", async () => {
    const n = await fake("pc");
    n.pairCode = "ABCD-EFGH";
    const r = await addMachine("ABCD-EFGH", {
      svc: svc(),
      discover: async () => [
        { name: "x", url: "http://127.0.0.1:1", paired: false },
        { name: "pc", url: n.url, paired: false },
      ],
      client: { timeoutMs: 1500 },
    });
    expect(r.node.name).toBe("pc");
    expect(r.verified).toBe(true);
  });
});

describe("fleet nodes (S7, capacity)", () => {
  it("shows an update notice for an older node and the total capacity", async () => {
    const a = await fake("a", { slots: 4, slotsUsed: 1, version: "0.0.1" });
    const b = await fake("b", { slots: 2, version: "999.0.0" });
    const s = svc();
    await addMachine(a.pairing(), { svc: s, client: { timeoutMs: 1500 } });
    await addMachine(b.pairing(), { svc: s, client: { timeoutMs: 1500 } });
    await fleet(["nodes"], s);
    expect(output()).toContain("notice: a runs EZ Coder 0.0.1");
    expect(output()).toContain("ezcoder fleet update a");
    expect(output()).not.toContain("notice: b");
    expect(output()).toContain("Capacity: 8 slots: this machine 2, nodes 1/6 used");
  });

  it("fleet update calls POST /v1/update on the node", async () => {
    const n = await fake("pc");
    const s = svc();
    await addMachine(n.pairing(), { svc: s, client: { timeoutMs: 1500 } });
    await fleet(["update", "pc", "--version", "1.2.3", "--force"], s);
    expect(n.updates).toEqual([{ version: "1.2.3", force: true }]);
    expect(output()).toContain("updating EZ Coder 0.0.0-test -> 1.2.3");
  });
});

describe("rotate-token and share-auth (S4, R8)", () => {
  it("rotates the token on the node and stores the new one", async () => {
    const n = await fake("pc");
    const s = svc();
    await addMachine(n.pairing(), { svc: s, client: { timeoutMs: 1500 } });
    await fleet(["rotate-token", "pc"], s);
    expect(n.token).not.toBe(TOKEN);
    expect((await s.registry.get("pc"))!.token).toBe(n.token);
    expect(output()).toContain(n.pairing());
    // The stored token works.
    expect((await listMachines({ svc: s }))[0]!.online).toBe(true);
  });

  it("passes force only with --force and explains a 409", async () => {
    const n = await fake("pc");
    n.hasAuth = true;
    const s = svc();
    await addMachine(n.pairing(), { svc: s, client: { timeoutMs: 1500 } });
    const authFile = path.join(tmp, "auth.json");
    fs.writeFileSync(authFile, JSON.stringify({ anthropic: { key: "k" }, "local:x": {} }));
    await expect(shareAuth("pc", { svc: s, authFile })).rejects.toThrow(
      /already has its own model login, so nothing was changed/,
    );
    expect(n.sharedAuth).toHaveLength(0);
    expect(await shareAuth("pc", { svc: s, authFile, force: true })).toEqual({
      providers: ["anthropic"],
    });
    expect(n.sharedAuth).toEqual([{ credentials: { anthropic: { key: "k" } }, force: true }]);
  });
});

describe("machines facade", () => {
  it("lists machines with live state and computes capacity; remove forgets one", async () => {
    const a = await fake("a", {
      slots: 6,
      slotsUsed: 2,
      gpus: [{ name: "RTX", memoryGb: 24, vendor: "nvidia" }],
    });
    const old = await fake("old", { protocol: 1, minProtocol: 1, slots: 4 });
    const s = svc();
    await addMachine(a.pairing(), { svc: s, client: { timeoutMs: 1500 } });
    await addMachine(old.pairing(), { svc: s, offline: true });
    await s.registry.add({ name: "off", url: "http://127.0.0.1:1", token: TOKEN, labels: [] });
    const ms = await listMachines({ svc: s });
    const by = Object.fromEntries(ms.map((m) => [m.name, m]));
    expect(by.a).toMatchObject({ online: true, slots: 6, slotsUsed: 2, protocol: 2 });
    expect(by.a!.gpus[0]!.name).toBe("RTX");
    expect(by.old!.incompatible).toMatch(/update the node/);
    expect(by.off!.online).toBe(false);
    expect(fleetCapacity(ms, 2)).toEqual({ local: 2, nodesUsed: 2, nodesTotal: 6, total: 8 });
    expect(await removeMachine("off", { svc: s })).toBe(true);
    expect(await removeMachine("off", { svc: s })).toBe(false);
  });

  it("addMachine returns the doctor report and rotateMachineToken returns the new pairing", async () => {
    const n = await fake("pc");
    const s = svc();
    const r = await addMachine(n.pairing(), {
      svc: s,
      repo: "https://github.com/o/r",
      client: { timeoutMs: 1500 },
    });
    expect(r.doctor?.ok).toBe(true);
    expect(n.doctorRepos).toEqual(["https://github.com/o/r"]);
    const { pairing } = await rotateMachineToken("pc", { svc: s });
    expect(pairing).toContain(n.token);
  });
});

describe("discovery (S3)", () => {
  it("marks a discovered node with an older protocol as incompatible", async () => {
    const n = await fake("old", { protocol: 1, minProtocol: 1 });
    const port = Number(new URL(n.url).port);
    const exec: Exec = async () => ({
      code: 0,
      stdout: JSON.stringify({
        Peer: { x: { HostName: "old", DNSName: "", TailscaleIPs: ["127.0.0.1"], Online: true } },
      }),
      stderr: "",
    });
    const found = await discoverNodes({ exec, dir: fleetDir, port, timeoutMs: 1000 });
    expect(found[0]!.incompatible).toMatch(/update the node/);
  });
});
