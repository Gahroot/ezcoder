import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../system-prompt.js";
import type { MachineView } from "./machines.js";
import { fleetCapacity } from "./machines.js";
import { loadFleetHint, renderFleetHint } from "./prompt-hint.js";
import type { FleetService } from "./service.js";

const machine = (over: Partial<MachineView> = {}): MachineView => ({
  name: "box",
  url: "http://box:7377",
  online: true,
  gpus: [{ name: "RTX 4090", memoryGb: 24, vendor: "nvidia" }],
  slots: 8,
  slotsUsed: 2,
  labels: [],
  tls: false,
  ourJobs: 0,
  jobs: [],
  services: [],
  agents: [],
  ...over,
});

describe("fleet prompt hint (A5)", () => {
  it("is absent with no paired node", async () => {
    expect(renderFleetHint({ machines: [], capacity: fleetCapacity([], 4) })).toBeUndefined();
    const svc = { registry: { list: async () => [] } } as unknown as FleetService;
    expect(await loadFleetHint("/p", svc)).toBeUndefined();
  });

  it("says when to prefer the fleet and when not, with capacity and defaults", () => {
    const machines = [machine(), machine({ name: "mac", online: false, gpus: [] })];
    const hint = renderFleetHint({
      machines,
      capacity: fleetCapacity(machines, 4),
      defaults: { e2e: "fleet", build: "local" },
    })!;
    expect(hint).toContain("Capacity: 12 slots (4 here, 8 on nodes, 2 in use)");
    expect(hint).toContain("RTX 4090 on box");
    expect(hint).toContain("mac (offline)");
    expect(hint).toMatch(/long builds, e2e\/browser tests, renders, GPU work, and many test runs/);
    expect(hint).toMatch(/quick edits.*local secrets/);
    expect(hint).toContain("e2e runs on the fleet; build runs locally");
  });

  it("is rendered into the system prompt only when the fleet tool is active", async () => {
    const fleetHint = "# Fleet\nCapacity: 12 slots";
    const env = { fleetHint, projectFiles: null };
    const withTool = await buildSystemPrompt(
      process.cwd(),
      [],
      false,
      undefined,
      ["read", "fleet"],
      undefined,
      undefined,
      env,
    );
    expect(withTool).toContain(fleetHint);
    const without = await buildSystemPrompt(
      process.cwd(),
      [],
      false,
      undefined,
      ["read"],
      undefined,
      undefined,
      env,
    );
    expect(without).not.toContain(fleetHint);
  });
});
