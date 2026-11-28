import { describe, expect, it } from "vitest";
import type { ExecResult, NodeExec } from "./exec.js";
import { installUpdate, runningUnderService, UpdateError } from "./update.js";
import { createOpsRouteModule } from "./ops-routes.js";
import { api, startTestServer, tempDir } from "./__fixtures__/server.js";

function npm(latest = "5.40.0"): NodeExec & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (_cmd: string, args: string[]): Promise<ExecResult> => {
    calls.push(args);
    if (args[0] === "view") {
      const spec = args[1]!;
      if (spec.endsWith("@9.9.9")) return { code: 1, stdout: "", stderr: "E404 not found" };
      return {
        code: 0,
        stdout: spec.endsWith("@latest") ? latest : spec.split("@").pop()!,
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  }) as NodeExec & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

describe("node update", () => {
  it("installs the requested version with npm i -g", async () => {
    const exec = npm();
    const r = await installUpdate({
      request: { version: "v5.39.1" },
      activeWork: () => 0,
      exec,
      npm: "npm",
      currentVersion: "5.38.0",
      underService: () => true,
    });
    expect(r).toEqual({ from: "5.38.0", to: "5.39.1", restarting: true });
    expect(exec.calls.at(-1)).toEqual(["install", "-g", "@prestyj/cli@5.39.1"]);
  });

  it("does nothing when already on that version", async () => {
    const exec = npm("5.38.0");
    const r = await installUpdate({
      request: {},
      activeWork: () => 0,
      exec,
      currentVersion: "5.38.0",
    });
    expect(r.restarting).toBe(false);
    expect(exec.calls.some((c) => c[0] === "install")).toBe(false);
  });

  it("refuses while work runs unless forced", async () => {
    const exec = npm();
    const busy = installUpdate({ request: {}, activeWork: () => 2, exec, currentVersion: "1.0.0" });
    await expect(busy).rejects.toThrow(/2 job\(s\) or agent\(s\) are running/);
    await expect(busy).rejects.toMatchObject({ status: 409 });
    expect(exec.calls).toEqual([]);
    const forced = await installUpdate({
      request: { force: true },
      activeWork: () => 2,
      exec,
      currentVersion: "1.0.0",
      underService: () => false,
    });
    expect(forced.to).toBe("5.40.0");
  });

  it("rejects bad and unknown versions", async () => {
    const o = { activeWork: () => 0, exec: npm(), currentVersion: "1.0.0" };
    await expect(
      installUpdate({ ...o, request: { version: "1.0; rm -rf ~" } }),
    ).rejects.toBeInstanceOf(UpdateError);
    await expect(installUpdate({ ...o, request: { version: "9.9.9" } })).rejects.toThrow(
      /npm has no/,
    );
  });

  it("knows when it runs under systemd or launchd", () => {
    expect(runningUnderService({ INVOCATION_ID: "x" })).toBe(true);
    expect(runningUnderService({ XPC_SERVICE_NAME: "dev.ezcoder.node" })).toBe(true);
    expect(runningUnderService({})).toBe(false);
  });

  it("POST /v1/update answers 202, and 409 while busy", async () => {
    let restarted = 0;
    let active = 1;
    const ops = createOpsRouteModule({
      activeWork: () => active,
      update: {
        exec: npm(),
        npm: "npm",
        currentVersion: "1.0.0",
        underService: () => true,
        restart: () => restarted++,
      },
      runDoctor: async (o) => ({
        node: o.config.name,
        version: "1",
        protocol: 2,
        checks: [],
        ok: true,
      }),
    });
    const s = await startTestServer(tempDir(), {}, { modules: [ops] });
    try {
      const call = api(s);
      const busy = await call("POST", "/v1/update", {});
      expect(busy.status).toBe(409);
      active = 0;
      const res = await call("POST", "/v1/update", { version: "5.39.0" });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ from: "1.0.0", to: "5.39.0", restarting: true });
      await new Promise((r) => setTimeout(r, 700));
      expect(restarted).toBe(1);
      const doc = await call("GET", "/v1/doctor?repo=https://x/y");
      expect(doc.status).toBe(200);
      expect(await doc.json()).toMatchObject({ node: "test-node", ok: true });
      expect((await fetch(s.url + "/v1/update", { method: "POST" })).status).toBe(401);
    } finally {
      await s.close();
    }
  });
});
