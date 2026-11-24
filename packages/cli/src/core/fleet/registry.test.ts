import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FleetClient, FleetClientError, getNodeInfo, nodeClient } from "./client.js";
import { discoverNodes, parseTailscaleStatus } from "./discovery.js";
import { NodeRegistry, parsePairing } from "./registry.js";
import { startFakeNode, type FakeNode } from "./__fixtures__/fake-node.js";
import type { Exec } from "../validation/types.js";

const TOKEN = "a".repeat(32);
let tmp: string;
let nodes: FakeNode[] = [];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ezf-reg-"));
});
afterEach(async () => {
  await Promise.all(nodes.map((n) => n.close()));
  nodes = [];
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("parsePairing", () => {
  it("parses name, host, port and token", () => {
    const p = parsePairing(`ezfleet://gpu-box@gpu-box.tailnet.ts.net:7400#${TOKEN}`);
    expect(p).toEqual({
      name: "gpu-box",
      host: "gpu-box.tailnet.ts.net",
      port: 7400,
      url: "http://gpu-box.tailnet.ts.net:7400",
      token: TOKEN,
    });
  });
  it("defaults the port", () => {
    expect(parsePairing(`ezfleet://my-pc@100.64.0.2#${TOKEN}`).url).toBe("http://100.64.0.2:7377");
  });
  it("rejects junk, short tokens and bad names", () => {
    expect(() => parsePairing("http://x")).toThrow(/pairing string/);
    expect(() => parsePairing("ezfleet://my-pc@host:7377#short")).toThrow(/too short/);
    expect(() => parsePairing(`ezfleet://-bad@host:7377#${TOKEN}`)).toThrow(/invalid node name/);
  });
});

describe("NodeRegistry", () => {
  it("adds, replaces and removes nodes in a 0600 file", async () => {
    const reg = new NodeRegistry(tmp);
    await reg.add({ name: "my-pc", url: "http://h:1/", token: TOKEN, labels: [] });
    await reg.add({ name: "my-pc", url: "http://h:2", token: TOKEN, labels: ["deploy"] });
    const list = await reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ url: "http://h:2", labels: ["deploy"] });
    if (process.platform !== "win32") expect(fs.statSync(reg.file).mode & 0o777).toBe(0o600);
    expect(await reg.remove("my-pc")).toBe(true);
    expect(await reg.list()).toEqual([]);
  });
});

describe("client", () => {
  it("talks to a node with its token and caches info", async () => {
    const n = await startFakeNode("my-pc", {}, TOKEN);
    nodes.push(n);
    await new NodeRegistry(tmp).add({ name: "my-pc", url: n.url, token: TOKEN, labels: [] });
    const c = await nodeClient("my-pc", { dir: tmp });
    expect((await c.hello()).name).toBe("my-pc");
    const info = await getNodeInfo("my-pc", { dir: tmp });
    n.info.cpus = 99;
    expect((await getNodeInfo("my-pc", { dir: tmp })).cpus).toBe(info.cpus);
    expect((await getNodeInfo("my-pc", { dir: tmp, force: true })).cpus).toBe(99);
    await expect(nodeClient("nope", { dir: tmp })).rejects.toThrow(/no paired node "nope"/);
  });

  it("turns failures into clear errors", async () => {
    const n = await startFakeNode("my-pc", {}, TOKEN);
    nodes.push(n);
    const bad = new FleetClient("my-pc", n.url, "wrong-token");
    await expect(bad.info()).rejects.toMatchObject({ code: "auth" });
    const good = new FleetClient("my-pc", n.url, TOKEN);
    await expect(good.job("missing")).rejects.toMatchObject({ code: "not_found" });
    n.full = true;
    await expect(
      good.submitJob({ id: "j", kind: "build", project: "p", command: "x", timeoutMinutes: 1 }),
    ).rejects.toMatchObject({ code: "busy" });
    const gone = new FleetClient("gone", "http://127.0.0.1:1", TOKEN, { timeoutMs: 2000 });
    const err = await gone.info().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FleetClientError);
    expect((err as FleetClientError).message).toMatch(/unreachable/);
  });
});

describe("discovery", () => {
  it("parses online peers only", () => {
    const peers = parseTailscaleStatus(
      JSON.stringify({
        Peer: {
          a: {
            HostName: "my-pc",
            DNSName: "my-pc.tailnet.ts.net.",
            TailscaleIPs: ["100.64.0.2"],
            Online: true,
          },
          b: {
            HostName: "off",
            DNSName: "off.tailnet.ts.net.",
            TailscaleIPs: ["100.64.0.3"],
            Online: false,
          },
        },
      }),
    );
    expect(peers).toEqual([
      { hostName: "my-pc", dnsName: "my-pc.tailnet.ts.net", ips: ["100.64.0.2"] },
    ]);
  });

  it("probes peers on /v1/hello and flags unpaired ones", async () => {
    const a = await startFakeNode("my-pc", {}, TOKEN);
    const b = await startFakeNode("gpu-box", {}, TOKEN);
    nodes.push(a, b);
    await new NodeRegistry(tmp).add({ name: "my-pc", url: a.url, token: TOKEN, labels: [] });
    const portOf = (u: string) => Number(new URL(u).port);
    const exec: Exec = async (cmd) =>
      cmd === "tailscale"
        ? {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              Peer: {
                a: { HostName: "my-pc", DNSName: "", TailscaleIPs: ["127.0.0.1"], Online: true },
                b: { HostName: "gpu-box", DNSName: "localhost", TailscaleIPs: [], Online: true },
                c: { HostName: "phone", DNSName: "", TailscaleIPs: ["127.0.0.2"], Online: true },
              },
            }),
          }
        : { code: 1, stdout: "", stderr: "no" };
    // Each fake listens on its own port; route by peer host to the right one.
    const fetchFn: typeof fetch = (input, init) => {
      const u = new URL(String(input));
      const target =
        u.hostname === "localhost"
          ? b.url
          : u.hostname === "127.0.0.1"
            ? a.url
            : "http://127.0.0.1:1";
      return fetch(`${target}${u.pathname}`, init);
    };
    const found = await discoverNodes({
      exec,
      fetch: fetchFn,
      dir: tmp,
      port: portOf(a.url),
      timeoutMs: 1000,
    });
    expect(found.map((f) => [f.name, f.paired]).sort()).toEqual([
      ["gpu-box", false],
      ["my-pc", true],
    ]);
  });
});
