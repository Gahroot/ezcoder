import { describe, expect, it } from "vitest";
import { isRemoteMachine, machineLabel } from "./machine-label";

describe("machineLabel", () => {
  it("names the machine, falling back to this computer", () => {
    expect(machineLabel("gpu-box")).toBe("gpu-box");
    expect(machineLabel(undefined)).toBe("this computer");
    expect(machineLabel("  ")).toBe("this computer");
    expect(machineLabel("local")).toBe("this computer");
    expect(machineLabel("auto")).toBe("another machine");
    expect(machineLabel("cloud")).toBe("the cloud");
  });

  it("tells remote work from local", () => {
    expect(isRemoteMachine("gpu-box")).toBe(true);
    expect(isRemoteMachine("auto")).toBe(true);
    expect(isRemoteMachine(undefined)).toBe(false);
  });
});
