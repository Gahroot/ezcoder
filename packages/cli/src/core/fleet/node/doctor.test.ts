import { describe, expect, it } from "vitest";
import type { ExecResult, NodeExec } from "./exec.js";
import { formatDoctorReport, runDoctor, type DoctorOptions } from "./doctor.js";
import { memorySecretStore, unavailableStore } from "./secrets.js";
import { tempDir, testConfig } from "./__fixtures__/server.js";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (code: number, stderr = ""): ExecResult => ({ code, stdout: "", stderr });

function fakeExec(map: Record<string, ExecResult>): NodeExec & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return map[`${cmd} ${args[0]}`] ?? map[cmd] ?? fail(127);
  }) as NodeExec & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

function base(over: Partial<DoctorOptions> = {}): DoctorOptions {
  return {
    config: testConfig(tempDir(), { slots: 2 }),
    platform: "linux",
    tailscale: async () => ({ running: true, ip: "100.64.0.1", dnsName: "box.ts.net" }),
    gpus: async () => [],
    diskFreeGb: async () => 100,
    modelProviders: async () => ["anthropic"],
    secretStore: memorySecretStore(),
    version: "1.2.3",
    cpus: 8,
    exec: fakeExec({ docker: ok('{"runc":{}}'), git: ok("abc\tHEAD") }),
    ...over,
  };
}

const byId = (r: Awaited<ReturnType<typeof runDoctor>>, id: string) =>
  r.checks.find((c) => c.id === id)!;

describe("node doctor", () => {
  it("is ok on a healthy machine and has no fixes", async () => {
    const r = await runDoctor(base({ repo: "https://github.com/you/repo" }));
    expect(r.ok).toBe(true);
    expect(r.checks.every((c) => !c.fix)).toBe(true);
    expect(byId(r, "git").status).toBe("ok");
    expect(byId(r, "gpu").status).toBe("skip");
    expect(formatDoctorReport(r)).toContain("ready for work");
  });

  it("gives one fix per failed check", async () => {
    const r = await runDoctor(
      base({
        repo: "git@github.com:you/private.git",
        tailscale: async () => ({ running: false }),
        exec: fakeExec({ docker: fail(127), git: fail(128, "Permission denied (publickey).") }),
        diskFreeGb: async () => 2,
        modelProviders: async () => [],
        config: testConfig(tempDir(), { slots: 32, labels: ["deploy"] }),
        secretStore: unavailableStore,
      }),
    );
    expect(r.ok).toBe(false);
    for (const id of ["tailscale", "git", "disk", "keychain"]) {
      expect(byId(r, id).status).toBe("fail");
    }
    for (const id of ["docker", "model_login", "slots"]) expect(byId(r, id).status).toBe("warn");
    for (const c of r.checks.filter((x) => x.status === "fail" || x.status === "warn")) {
      expect(c.fix).toBeTruthy();
    }
    expect(byId(r, "git").fix).toMatch(/SSH key/);
    const text = formatDoctorReport(r);
    expect(text).toContain("fix: install Tailscale");
    expect(text).toContain("not ready");
  });

  it("checks GPU passthrough only when a GPU is present", async () => {
    const gpu = { name: "RTX 4090", memoryGb: 24, vendor: "nvidia" as const };
    const without = await runDoctor(base({ gpus: async () => [gpu] }));
    expect(byId(without, "gpu")).toMatchObject({ status: "fail" });
    expect(byId(without, "gpu").fix).toMatch(/nvidia-ctk/);
    const withRt = await runDoctor(
      base({ gpus: async () => [gpu], exec: fakeExec({ docker: ok('{"nvidia":{},"runc":{}}') }) }),
    );
    expect(byId(withRt, "gpu").status).toBe("ok");
  });

  it("refuses option-like and ext:: repo URLs without running git", async () => {
    const exec = fakeExec({ docker: ok() });
    const r = await runDoctor(base({ repo: "ext::sh -c touch% /tmp/x", exec }));
    expect(byId(r, "git").status).toBe("fail");
    expect(exec.calls.some((c) => c[0] === "git")).toBe(false);
  });

  it("strips credentials from the repo URL it reports", async () => {
    const r = await runDoctor(base({ repo: "https://user:hunter2@github.com/you/repo" }));
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });

  it("makes docker a failure on --docker-only nodes", async () => {
    const r = await runDoctor(
      base({
        config: testConfig(tempDir(), { dockerOnly: true }),
        exec: fakeExec({ docker: fail(1, "permission denied while trying to connect") }),
      }),
    );
    expect(byId(r, "docker")).toMatchObject({ status: "fail" });
    expect(byId(r, "docker").fix).toMatch(/usermod -aG docker/);
  });
});
