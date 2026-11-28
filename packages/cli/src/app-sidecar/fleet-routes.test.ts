import { Readable } from "node:stream";
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { FleetUserError, type FleetAdapter } from "./fleet-adapter.js";
import { handleFleetRoutes } from "./fleet-routes.js";

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

function call(
  adapter: FleetAdapter,
  method: string,
  url: string,
  body?: unknown,
): { handled: boolean; reply: Promise<Reply> } {
  let resolve: (r: Reply) => void = () => {};
  const reply = new Promise<Reply>((r) => (resolve = r));
  let status = 0;
  const res = {
    headersSent: false,
    destroyed: false,
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(payload: string) {
      resolve({ status, body: JSON.parse(payload) as Record<string, unknown> });
    },
  };
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  const handled = handleFleetRoutes(
    { cwd: "/work/app" },
    req as unknown as http.IncomingMessage,
    res as unknown as http.ServerResponse,
    url,
    method,
    adapter,
  );
  return { handled, reply };
}

function fakeAdapter(over: Partial<FleetAdapter> = {}): FleetAdapter {
  return {
    version: () => "1.2.0",
    listMachines: vi.fn(async () => []),
    overview: vi.fn(async () => ({
      machines: [],
      local: { slots: 2, slotsUsed: 1 },
      total: { slots: 2, slotsUsed: 1 },
    })),
    addMachine: vi.fn(async () => ({ name: "gpu-box", online: true })),
    removeMachine: vi.fn(async () => true),
    rotateMachineToken: vi.fn(async () => {}),
    shareAuth: vi.fn(async () => ({ status: "shared" as const, providers: ["anthropic"] })),
    doctor: vi.fn(async () => ({
      node: "gpu-box",
      version: "1",
      protocol: 2,
      checks: [],
      ok: true,
    })),
    activity: vi.fn(async () => ({ jobs: [], services: [] })),
    jobLog: vi.fn(async () => "job tail"),
    serviceLog: vi.fn(async () => "service tail"),
    ...over,
  };
}

describe("fleet routes", () => {
  it("ignores routes outside /fleet/", () => {
    expect(call(fakeAdapter(), "GET", "/tasks").handled).toBe(false);
    expect(call(fakeAdapter(), "POST", "/fleet/nope", {}).handled).toBe(false);
  });

  it("lists machines with capacity and this computer's version", async () => {
    const adapter = fakeAdapter();
    const { handled, reply } = call(adapter, "GET", "/fleet/machines");
    expect(handled).toBe(true);
    expect(await reply).toEqual({
      status: 200,
      body: {
        machines: [],
        local: { slots: 2, slotsUsed: 1 },
        total: { slots: 2, slotsUsed: 1 },
        version: "1.2.0",
      },
    });
  });

  it("reads activity for the window's project", async () => {
    const adapter = fakeAdapter();
    await call(adapter, "GET", "/fleet/activity").reply;
    expect(adapter.activity).toHaveBeenCalledWith("/work/app");
  });

  it("adds a machine and passes the offline choice", async () => {
    const adapter = fakeAdapter();
    const r = await call(adapter, "POST", "/fleet/machines/add", {
      pairing: " K7QM-2XPA ",
      offline: true,
    }).reply;
    expect(r.status).toBe(200);
    expect(adapter.addMachine).toHaveBeenCalledWith("K7QM-2XPA", { offline: true });
  });

  it("answers plain-words problems with 400 and others with 502", async () => {
    const plain = fakeAdapter({
      addMachine: vi.fn(async () => {
        throw new FleetUserError("Paste the pairing text or type the code first.");
      }),
    });
    expect(await call(plain, "POST", "/fleet/machines/add", {}).reply).toEqual({
      status: 400,
      body: { error: "Paste the pairing text or type the code first." },
    });
    const broken = fakeAdapter({
      rotateMachineToken: vi.fn(async () => {
        throw new Error("node gpu-box is unreachable");
      }),
    });
    const r = await call(broken, "POST", "/fleet/machines/rotate-token", { name: "gpu-box" }).reply;
    expect(r).toEqual({ status: 502, body: { error: "node gpu-box is unreachable" } });
  });

  it("needs a machine name for remove, rotate, share and doctor", async () => {
    for (const url of [
      "/fleet/machines/remove",
      "/fleet/machines/rotate-token",
      "/fleet/machines/share-auth",
      "/fleet/machines/doctor",
    ]) {
      const r = await call(fakeAdapter(), "POST", url, {}).reply;
      expect(r.status).toBe(400);
    }
  });

  it("removes, rotates, shares (with force) and runs doctor", async () => {
    const adapter = fakeAdapter();
    expect(
      (await call(adapter, "POST", "/fleet/machines/remove", { name: "a" }).reply).body,
    ).toEqual({ removed: true });
    expect(
      (await call(adapter, "POST", "/fleet/machines/rotate-token", { name: "a" }).reply).body,
    ).toEqual({ rotated: true });
    await call(adapter, "POST", "/fleet/machines/share-auth", { name: "a", force: true }).reply;
    expect(adapter.shareAuth).toHaveBeenCalledWith("a", { force: true });
    const doc = await call(adapter, "POST", "/fleet/machines/doctor", { name: "a" }).reply;
    expect(doc.body.ok).toBe(true);
  });

  it("tails job and service logs, clamping the line count", async () => {
    const adapter = fakeAdapter();
    const job = await call(adapter, "POST", "/fleet/log", { id: "fj1", tail: 99_999 }).reply;
    expect(job.body).toEqual({ text: "job tail" });
    expect(adapter.jobLog).toHaveBeenCalledWith("fj1", 2000);
    const svc = await call(adapter, "POST", "/fleet/log", { id: "s1", kind: "service" }).reply;
    expect(svc.body).toEqual({ text: "service tail" });
    expect(adapter.serviceLog).toHaveBeenCalledWith("s1", 200);
  });

  it("rejects a body that isn't a JSON object", async () => {
    const r = await call(fakeAdapter(), "POST", "/fleet/log", [1]).reply;
    expect(r.status).toBe(400);
  });
});
