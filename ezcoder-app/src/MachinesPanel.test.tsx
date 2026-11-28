// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  checkMachine,
  removeMachine,
  rotateMachineToken,
  shareMachineLogin,
  type Machine,
} from "./agent";
import { MachinesPanel } from "./MachinesPanel";
import { SettingsHeaderProvider } from "./settings-header";
import type { MachinesState } from "./use-fleet";

vi.mock("./agent", () => ({
  addMachine: vi.fn(),
  checkMachine: vi.fn(),
  listMachines: vi.fn(() => new Promise(() => {})),
  removeMachine: vi.fn(),
  rotateMachineToken: vi.fn(),
  shareMachineLogin: vi.fn(),
}));
vi.mock("./toast", () => ({ toast: vi.fn() }));

const removeMock = vi.mocked(removeMachine);
const rotateMock = vi.mocked(rotateMachineToken);
const shareMock = vi.mocked(shareMachineLogin);
const checkMock = vi.mocked(checkMachine);

function machine(over: Partial<Machine> = {}): Machine {
  return {
    name: "gpu-box",
    address: "gpu-box.tail.ts.net:7377",
    online: true,
    platform: "linux",
    version: "1.2.0",
    load: 0.25,
    gpus: [{ name: "RTX 4090", memoryGb: 24 }],
    slots: 4,
    slotsUsed: 3,
    running: { jobs: 2, services: 1, agents: 1 },
    ourJobs: 2,
    labels: [],
    notices: [],
    addedAt: "2026-11-27T00:00:00.000Z",
    ...over,
  };
}

function state(over: Partial<MachinesState> = {}): MachinesState {
  return {
    machines: [machine()],
    version: "1.3.0",
    local: { slots: 2, slotsUsed: 1 },
    total: { slots: 6, slotsUsed: 4 },
    loading: false,
    error: null,
    refresh: vi.fn(async () => {}),
    ...over,
  };
}

/** The panel inside the Settings header's slots, as the screen renders it. */
function Harness({ value }: { value: MachinesState }): React.ReactElement {
  const [status, setStatus] = useState<HTMLSpanElement | null>(null);
  const [actions, setActions] = useState<HTMLSpanElement | null>(null);
  return (
    <>
      <span data-testid="status" ref={setStatus} />
      <span ref={setActions} />
      <SettingsHeaderProvider slots={{ status, actions }}>
        <MachinesPanel state={value} />
      </SettingsHeaderProvider>
    </>
  );
}

beforeEach(() => {
  for (const m of [removeMock, rotateMock, shareMock, checkMock]) m.mockReset();
});
afterEach(cleanup);

function row(name = "gpu-box"): HTMLElement {
  return screen.getByRole("listitem", { name });
}

describe("MachinesPanel", () => {
  it("explains what machines are for when there are none", () => {
    render(<Harness value={state({ machines: [], total: { slots: 2, slotsUsed: 0 } })} />);
    expect(screen.getByText(/No other machines yet/)).toBeTruthy();
    expect(screen.getByTestId("status").textContent).toBe("None yet");
    expect(screen.getByRole("button", { name: "Add a machine" })).toBeTruthy();
  });

  it("shows room for work across this computer and every machine", () => {
    render(
      <Harness
        value={state({
          machines: [machine(), machine({ name: "old-mac", online: false })],
          local: { slots: 2, slotsUsed: 1, estimated: true },
        })}
      />,
    );
    const all = screen.getByRole("region", { name: "Room for work" }).textContent ?? "";
    expect(all).toContain("All machines4 of 6 in use");
    expect(all).toContain("This computer1 of 2 in use (estimated)");
    expect(all).toContain("gpu-box3 of 4 in use");
    expect(all).toContain("old-macOffline");
    expect(screen.getByTestId("status").textContent).toBe("1 of 2 online");
  });

  it("lists each machine's state, slots, load, graphics, work and how to change slots", () => {
    render(
      <Harness
        value={state({
          machines: [
            machine({
              notices: [{ kind: "update", text: "This machine has EZ Coder 1.2.0; update it." }],
            }),
          ],
        })}
      />,
    );
    const r = row().textContent ?? "";
    expect(r).toContain("Online");
    expect(r).toContain("Update needed");
    expect(r).toContain("Slots3 of 4 in use");
    expect(r).toContain("Load25% busy");
    expect(r).toContain("RTX 4090 (24 GB)");
    expect(r).toContain("2 jobs, 1 helper agent, 1 service");
    expect(r).toContain("This machine has EZ Coder 1.2.0; update it.");
    expect(r).toContain("ezcoder node config --slots N");
  });

  it("removes a machine after a plain-words confirmation", async () => {
    const value = state();
    removeMock.mockResolvedValue({ removed: true });
    render(<Harness value={value} />);
    fireEvent.click(within(row()).getByRole("button", { name: "Remove" }));
    const dialog = screen.getByRole("dialog", { name: "Remove gpu-box?" });
    expect(dialog.textContent).toContain("stops sending work to gpu-box");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await vi.waitFor(() => expect(value.refresh).toHaveBeenCalled());
    expect(removeMock).toHaveBeenCalledWith("gpu-box");
  });

  it("gives a machine a new key after confirming, and cancel does nothing", async () => {
    const value = state();
    rotateMock.mockResolvedValue({ rotated: true });
    render(<Harness value={value} />);
    fireEvent.click(within(row()).getByRole("button", { name: "New key" }));
    let dialog = screen.getByRole("dialog", { name: "Give gpu-box a new key?" });
    expect(dialog.textContent).toContain("old one stops working straight away");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(rotateMock).not.toHaveBeenCalled();
    fireEvent.click(within(row()).getByRole("button", { name: "New key" }));
    dialog = screen.getByRole("dialog", { name: "Give gpu-box a new key?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Give it a new key" }));
    await vi.waitFor(() => expect(rotateMock).toHaveBeenCalledWith("gpu-box"));
  });

  it("shares the model login, asking again before replacing the machine's own", async () => {
    const value = state();
    shareMock
      .mockResolvedValueOnce({ status: "exists", providers: ["anthropic"] })
      .mockResolvedValueOnce({ status: "shared", providers: ["anthropic"] });
    render(<Harness value={value} />);
    fireEvent.click(within(row()).getByRole("button", { name: "Share model login" }));
    const first = screen.getByRole("dialog", { name: "Share your model login with gpu-box?" });
    expect(first.textContent).toContain("may sign this computer out");
    fireEvent.click(within(first).getByRole("button", { name: "Share login" }));
    const again = await screen.findByRole("dialog", { name: "Replace gpu-box's own login?" });
    expect(shareMock).toHaveBeenLastCalledWith("gpu-box", false);
    fireEvent.click(within(again).getByRole("button", { name: "Replace it" }));
    await vi.waitFor(() => expect(shareMock).toHaveBeenLastCalledWith("gpu-box", true));
    await vi.waitFor(() => expect(value.refresh).toHaveBeenCalled());
  });

  it("runs a machine's checks and shows them", async () => {
    checkMock.mockResolvedValue({
      node: "gpu-box",
      version: "1.2.0",
      protocol: 2,
      ok: true,
      checks: [{ id: "docker", status: "ok", detail: "Docker is running." }],
    });
    render(<Harness value={state()} />);
    fireEvent.click(within(row()).getByRole("button", { name: "Check" }));
    const dialog = await screen.findByRole("dialog", { name: "Checks for gpu-box" });
    expect(dialog.textContent).toContain("Docker is running.");
  });

  it("disables online-only actions for an offline machine", () => {
    render(<Harness value={state({ machines: [machine({ online: false })] })} />);
    for (const name of ["Check", "Share model login", "New key"]) {
      expect((within(row()).getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    }
    expect(
      (within(row()).getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
