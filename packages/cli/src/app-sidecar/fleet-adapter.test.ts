import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FleetService } from "../core/fleet/service.js";
import type { NodeInfo } from "../core/fleet/protocol.js";
import {
  compareVersions,
  createFleetAdapter,
  doctorFromInfo,
  FleetUserError,
  machineNotices,
} from "./fleet-adapter.js";

const TOKEN = "t".repeat(32);
const PAIRING = `ezfleet://gpu-box@gpu-box.tail.ts.net:7377#${TOKEN}`;

function info(over: Partial<NodeInfo> = {}): NodeInfo {
  return {
    ezcoderNode: true,
    protocol: 2,
    name: "gpu-box",
    version: "1.2.0",
    platform: "linux",
    hostname: "gpu-box",
    arch: "x64",
    cpus: 8,
    memoryGb: 32,
    memoryFreeGb: 20,
    load: 0.25,
    diskFreeGb: 120,
    gpus: [{ name: "RTX 4090", memoryGb: 24, vendor: "nvidia" }],
    docker: true,
    labels: ["gpu"],
    slots: 2,
    slotsUsed: 1,
    modelAuth: false,
    jobs: [
      { id: "a", kind: "test", project: "p", state: "running", logBytes: 0 },
      { id: "b", kind: "test", project: "p", state: "passed", logBytes: 0 },
    ],
    services: [],
    agents: [],
    ...over,
  };
}

type Route = (req: { method: string; url: URL; body: unknown; auth?: string }) => Response;

let tmp: string;
let calls: string[];
let routes: Map<string, Route>;

function fakeFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const key = `${method} ${url.host}${url.pathname}`;
    calls.push(key);
    // A node's hello is its info without auth; tests only set the info route.
    const route =
      routes.get(key) ??
      (url.pathname === "/v1/hello" ? routes.get(`GET ${url.host}/v1/info`) : undefined);
    if (!route) return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
    const headers = (init?.headers ?? {}) as Record<string, string>;
    return route({
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.authorization,
    });
  }) as typeof fetch;
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function setup(opts: { authFile?: string; discover?: () => Promise<never[]> } = {}) {
  const fetchImpl = fakeFetch();
  const service = new FleetService({
    dir: path.join(tmp, "fleet"),
    fetch: fetchImpl,
    autoStart: false,
    cloud: false,
    localEndpoints: false,
  });
  const adapter = createFleetAdapter({
    service,
    fetch: fetchImpl,
    version: "1.3.0",
    authFile: opts.authFile ?? path.join(tmp, "auth.json"),
    ...(opts.discover ? { discover: opts.discover } : {}),
  });
  return { service, adapter };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ez-fleet-adapter-"));
  calls = [];
  routes = new Map();
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("version and notices", () => {
  it("compares dotted versions", () => {
    expect(compareVersions("1.2.0", "1.10.0")).toBe(-1);
    expect(compareVersions("v2.0.0", "2.0.0-beta.1")).toBe(0);
    expect(compareVersions("3.0.1", "3.0.0")).toBe(1);
  });

  it("asks to update an older machine and names the side for protocol gaps", () => {
    expect(machineNotices(info(), "1.3.0", true)[0]).toMatchObject({ kind: "update" });
    expect(machineNotices(info({ protocol: 1 }), "1.3.0", true)[0]?.text).toMatch(
      /too old.*ezcoder node update/,
    );
    expect(machineNotices(info({ protocol: 9, minProtocol: 9 }), "1.3.0", true)[0]?.text).toMatch(
      /Update EZ Coder here/,
    );
    expect(machineNotices(info({ version: "1.3.0" }), "1.3.0", true)).toEqual([]);
    expect(machineNotices(undefined, "1.3.0", false, "timeout")[0]?.kind).toBe("offline");
  });

  it("builds a doctor report from info for nodes without /v1/doctor", () => {
    const r = doctorFromInfo(info({ docker: false }), "1.2.0");
    expect(r.ok).toBe(true);
    const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    expect(byId.docker).toMatchObject({ status: "warn" });
    expect(byId.docker?.fix).toBeTruthy();
    expect(byId.model_login).toMatchObject({ status: "warn" });
    expect(byId.gpu).toMatchObject({ status: "ok" });
  });
});

describe("machines", () => {
  it("lists paired machines with live state, never the token", async () => {
    routes.set("GET gpu-box.tail.ts.net:7377/v1/info", () => ok(info()));
    const { service, adapter } = setup();
    await service.registry.add({
      name: "gpu-box",
      url: "http://gpu-box.tail.ts.net:7377",
      token: TOKEN,
      labels: ["render"],
    });
    const [m] = await adapter.listMachines();
    expect(m).toMatchObject({
      name: "gpu-box",
      address: "gpu-box.tail.ts.net:7377",
      online: true,
      load: 0.25,
      slots: 2,
      slotsUsed: 1,
      gpus: [{ name: "RTX 4090", memoryGb: 24 }],
      running: { jobs: 1, services: 0, agents: 0 },
      labels: ["gpu", "render"],
    });
    expect(m?.notices.map((n) => n.kind)).toEqual(["update"]);
    expect(JSON.stringify(m)).not.toContain(TOKEN);
  });

  it("shows an unreachable machine as offline", async () => {
    const { service, adapter } = setup();
    await service.registry.add({
      name: "old-mac",
      url: "http://old-mac:7377",
      token: TOKEN,
      labels: [],
    });
    const [m] = await adapter.listMachines();
    expect(m?.online).toBe(false);
    expect(m?.notices[0]?.kind).toBe("offline");
  });

  it("adds by pairing text and runs doctor", async () => {
    routes.set("GET gpu-box.tail.ts.net:7377/v1/info", () => ok(info()));
    routes.set("GET gpu-box.tail.ts.net:7377/v1/doctor", () =>
      ok({ node: "gpu-box", version: "1.2.0", protocol: 2, checks: [], ok: true }),
    );
    const { service, adapter } = setup();
    const r = await adapter.addMachine(PAIRING);
    expect(r).toMatchObject({ name: "gpu-box", online: true, doctor: { ok: true } });
    expect((await service.registry.get("gpu-box"))?.token).toBe(TOKEN);
  });

  it("falls back to an info-based doctor on older nodes", async () => {
    routes.set("GET gpu-box.tail.ts.net:7377/v1/info", () => ok(info()));
    const { adapter } = setup();
    const r = await adapter.addMachine(PAIRING);
    expect(r.doctor?.checks.some((c) => c.id === "docker")).toBe(true);
  });

  it("refuses an unreachable machine unless offline is chosen", async () => {
    const { service, adapter } = setup();
    await expect(adapter.addMachine(PAIRING)).rejects.toBeInstanceOf(FleetUserError);
    expect(await service.registry.list()).toEqual([]);
    expect(await adapter.addMachine(PAIRING, { offline: true })).toEqual({
      name: "gpu-box",
      online: false,
    });
    expect(await service.registry.list()).toHaveLength(1);
  });

  it("rejects text that is neither a pairing string nor a code", async () => {
    const { adapter } = setup();
    await expect(adapter.addMachine("hello")).rejects.toThrow(/isn't a pairing text or code/);
    await expect(adapter.addMachine("")).rejects.toThrow(/Paste the pairing text/);
  });

  it("swaps a short code for the pairing string via a discovered machine", async () => {
    routes.set("POST gpu-box:7377/v1/pair", ({ body }) =>
      (body as { code: string }).code === "K7QM-2XPA"
        ? ok({ pairing: `ezfleet://gpu-box@gpu-box:7377#${TOKEN}` })
        : new Response(JSON.stringify({ error: "bad" }), { status: 403 }),
    );
    routes.set("GET gpu-box:7377/v1/info", () => ok(info()));
    const fetchImpl = fakeFetch();
    const service = new FleetService({
      dir: path.join(tmp, "fleet"),
      fetch: fetchImpl,
      autoStart: false,
      cloud: false,
      localEndpoints: false,
    });
    const adapter = createFleetAdapter({
      service,
      fetch: fetchImpl,
      version: "1.3.0",
      discover: async () => [
        {
          name: "gpu-box",
          host: "gpu-box",
          url: "http://gpu-box:7377",
          platform: "linux",
          version: "1.2.0",
          protocol: 2,
          paired: false,
        } as never,
      ],
    });
    const r = await adapter.addMachine("k7qm-2xpa");
    expect(r.name).toBe("gpu-box");
  });

  it("removes and rotates the token, storing the new one", async () => {
    const NEW = "n".repeat(32);
    routes.set("POST gpu-box:7377/v1/token/rotate", ({ auth }) => {
      expect(auth).toBe(`Bearer ${TOKEN}`);
      return ok({ token: NEW, pairing: `ezfleet://gpu-box@gpu-box:7377#${NEW}` });
    });
    const { service, adapter } = setup();
    await service.registry.add({
      name: "gpu-box",
      url: "http://gpu-box:7377",
      token: TOKEN,
      labels: ["x"],
    });
    await adapter.rotateMachineToken("gpu-box");
    expect(await service.registry.get("gpu-box")).toMatchObject({ token: NEW, labels: ["x"] });
    expect(await adapter.removeMachine("gpu-box")).toBe(true);
    await expect(adapter.rotateMachineToken("gpu-box")).rejects.toThrow(/no machine called/);
  });

  it("shares model login, asking before replacing an existing one", async () => {
    const authFile = path.join(tmp, "auth.json");
    fs.writeFileSync(authFile, JSON.stringify({ anthropic: { key: "k" }, "local:ollama": {} }));
    const sent: unknown[] = [];
    routes.set("POST gpu-box:7377/v1/auth", ({ body }) => {
      sent.push(body);
      return (body as { force?: boolean }).force
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ error: "exists", code: "exists" }), { status: 409 });
    });
    const { service, adapter } = setup({ authFile });
    await service.registry.add({
      name: "gpu-box",
      url: "http://gpu-box:7377",
      token: TOKEN,
      labels: [],
    });
    expect(await adapter.shareAuth("gpu-box")).toEqual({
      status: "exists",
      providers: ["anthropic"],
    });
    expect(await adapter.shareAuth("gpu-box", { force: true })).toEqual({
      status: "shared",
      providers: ["anthropic"],
    });
    expect(sent[0]).toEqual({ credentials: { anthropic: { key: "k" } } });
  });

  it("refuses to share when this computer has no model login", async () => {
    const { service, adapter } = setup();
    await service.registry.add({
      name: "gpu-box",
      url: "http://gpu-box:7377",
      token: TOKEN,
      labels: [],
    });
    await expect(adapter.shareAuth("gpu-box")).rejects.toThrow(/no model login on this computer/);
  });
});

describe("capacity", () => {
  it("adds this computer's slots to every online machine's", async () => {
    routes.set("GET gpu-box:7377/v1/info", () => ok(info({ slots: 4, slotsUsed: 3 })));
    const fetchImpl = fakeFetch();
    const service = new FleetService({
      dir: path.join(tmp, "fleet"),
      fetch: fetchImpl,
      autoStart: false,
      cloud: false,
      localEndpoints: false,
    });
    const adapter = createFleetAdapter({
      service,
      fetch: fetchImpl,
      version: "1.3.0",
      localCapacity: async () => ({ slots: 2, slotsUsed: 1 }),
    });
    await service.registry.add({
      name: "gpu-box",
      url: "http://gpu-box:7377",
      token: TOKEN,
      labels: [],
    });
    await service.registry.add({
      name: "off",
      url: "http://off-box:7377",
      token: TOKEN,
      labels: [],
    });
    const o = await adapter.overview();
    expect(o.local).toEqual({ slots: 2, slotsUsed: 1 });
    expect(o.total).toEqual({ slots: 6, slotsUsed: 4 });
    expect(o.machines).toHaveLength(2);
  });

  it("uses the controller's own slot count for this computer", async () => {
    const { service, adapter } = setup();
    Object.assign(service, { localCapacity: () => 3 });
    const o = await adapter.overview();
    expect(o.local).toEqual({ slots: 3, slotsUsed: 0 });
    expect(o.total).toEqual({ slots: 3, slotsUsed: 0 });
  });
});

describe("activity", () => {
  it("lists this project's live jobs and services and recent finished jobs", async () => {
    const { service, adapter } = setup();
    const project = path.join(tmp, "proj");
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 3_600_000).toISOString();
    const base = {
      kind: "test" as const,
      project,
      projectKey: "proj",
      git: "x",
      sha: "abc",
      command: "npm test",
      timeoutMinutes: 10,
      createdAt: old,
    };
    await service.jobs.update((jobs) => {
      jobs.push(
        { ...base, id: "j1", name: "e2e", state: "running", node: "gpu-box", updatedAt: now },
        { ...base, id: "j2", name: "unit", state: "passed", updatedAt: now, finishedAt: now },
        { ...base, id: "j3", name: "old", state: "failed", updatedAt: old, finishedAt: old },
        {
          ...base,
          id: "j4",
          name: "other",
          project: "/elsewhere",
          state: "running",
          updatedAt: now,
        },
      );
    });
    await service.services.update((list) => {
      list.push({
        id: "s1",
        name: "llm",
        kind: "inference",
        node: "gpu-box",
        project,
        state: "running",
        endpoints: [{ name: "openai", url: "http://gpu-box:4000" }],
        createdAt: now,
        updatedAt: now,
      });
    });
    const a = await adapter.activity(project);
    expect(a.jobs.map((j) => j.id)).toEqual(["j1", "j2"]);
    expect(a.services.map((s) => s.name)).toEqual(["llm"]);
  });
});
