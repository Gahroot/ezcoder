// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { addMachine } from "./agent";
import { AddMachineModal } from "./AddMachineModal";

vi.mock("./agent", () => ({ addMachine: vi.fn() }));
vi.mock("./toast", () => ({ toast: vi.fn() }));

const addMachineMock = vi.mocked(addMachine);

beforeEach(() => {
  addMachineMock.mockReset();
});
afterEach(cleanup);

function input(): HTMLInputElement {
  return screen.getByLabelText("Code or pairing text from the other computer");
}

describe("AddMachineModal", () => {
  it("shows the commands for each platform", () => {
    render(<AddMachineModal onClose={vi.fn()} onAdded={vi.fn()} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Linux", "Windows (WSL2)", "macOS"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    const panel = screen.getByRole("tabpanel");
    expect(panel.textContent).toContain("npm i -g @prestyj/cli");
    expect(panel.textContent).toContain("ezcoder node init");
    expect(panel.textContent).toContain("ezcoder node pair --code");
    fireEvent.click(screen.getByRole("tab", { name: "Windows (WSL2)" }));
    expect(screen.getByRole("tab", { name: "Windows (WSL2)" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("tabpanel").textContent).toContain("wsl --install -d Ubuntu");
    fireEvent.click(screen.getByRole("tab", { name: "macOS" }));
    expect(screen.getByRole("tabpanel").textContent).toContain("Tailscale app");
  });

  it("pairs by short code and shows the checks with their fixes", async () => {
    const onAdded = vi.fn();
    addMachineMock.mockResolvedValue({
      name: "gpu-box",
      online: true,
      doctor: {
        node: "gpu-box",
        version: "1.2.0",
        protocol: 2,
        ok: true,
        checks: [
          { id: "docker", status: "ok", detail: "Docker is running." },
          { id: "model_login", status: "warn", detail: "No model login.", fix: "ezcoder login" },
        ],
      },
    });
    render(<AddMachineModal onClose={vi.fn()} onAdded={onAdded} />);
    const add = screen.getByRole("button", { name: "Add machine" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(input(), { target: { value: " K7QM-2XPA " } });
    fireEvent.click(add);
    await screen.findByText("gpu-box is ready to take work.");
    expect(addMachineMock).toHaveBeenCalledWith("K7QM-2XPA", false);
    expect(onAdded).toHaveBeenCalled();
    expect(screen.getByText("ezcoder login")).toBeTruthy();
  });

  it("pairs by pairing text, offline when asked, and says it's saved", async () => {
    addMachineMock.mockResolvedValue({ name: "old-mac", online: false });
    render(<AddMachineModal onClose={vi.fn()} onAdded={vi.fn()} />);
    fireEvent.change(input(), { target: { value: "ezfleet://old-mac@old-mac:7377#tok" } });
    fireEvent.click(screen.getByLabelText("Add it even if it's off right now"));
    fireEvent.keyDown(input(), { key: "Enter" });
    await screen.findByText(/old-mac is saved, but it's off right now/);
    expect(addMachineMock).toHaveBeenCalledWith("ezfleet://old-mac@old-mac:7377#tok", true);
  });

  it("shows the problem in plain words when pairing fails", async () => {
    addMachineMock.mockRejectedValue(new Error("Couldn't reach gpu-box."));
    render(<AddMachineModal onClose={vi.fn()} onAdded={vi.fn()} />);
    fireEvent.change(input(), { target: { value: "K7QM-2XPA" } });
    fireEvent.click(screen.getByRole("button", { name: "Add machine" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Couldn't reach gpu-box."),
    );
    expect(screen.getByRole("button", { name: "Add machine" })).toBeTruthy();
  });
});
