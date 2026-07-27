// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  getPermissionsStatus,
  getProjectMemoryEnabled,
  getSettings,
  setProjectMemoryEnabled,
} from "./agent";
import { SettingsModal } from "./SettingsModal";

vi.mock("./agent", () => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  getPermissionsStatus: vi.fn(),
  openPermissionsSettings: vi.fn(),
  getProjectMemoryEnabled: vi.fn(),
  setProjectMemoryEnabled: vi.fn(),
}));

vi.mock("./toast", () => ({ toast: vi.fn() }));
vi.mock("./SoundButton", () => ({ SoundButton: () => null }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const getSettingsMock = vi.mocked(getSettings);
const getPermissionsStatusMock = vi.mocked(getPermissionsStatus);
const getMemoryMock = vi.mocked(getProjectMemoryEnabled);
const setMemoryMock = vi.mocked(setProjectMemoryEnabled);

function setup(enabled: boolean) {
  getSettingsMock.mockResolvedValue({ projectsRoot: "/tmp/projects", configured: true });
  getPermissionsStatusMock.mockResolvedValue({ applicable: false, granted: false });
  getMemoryMock.mockResolvedValue(enabled);
  setMemoryMock.mockResolvedValue(undefined);
  return render(<SettingsModal onClose={vi.fn()} />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SettingsModal project memory toggle", () => {
  it("shows the current state so users can find the off switch", async () => {
    setup(true);

    expect(await screen.findByText("Project memory")).toBeTruthy();
    expect(await screen.findByText("On")).toBeTruthy();
    // The action offered is the opposite of the current state.
    expect(await screen.findByText("Turn off")).toBeTruthy();
  });

  it("renders as off when the setting is disabled", async () => {
    setup(false);

    expect(await screen.findByText("Off")).toBeTruthy();
    expect(await screen.findByText("Turn on")).toBeTruthy();
  });

  it("persists the change immediately, not on Save", async () => {
    setup(true);
    fireEvent.click(await screen.findByText("Turn off"));

    await waitFor(() => expect(setMemoryMock).toHaveBeenCalledWith(false));
    // Optimistic flip so the row reflects the click straight away.
    expect(await screen.findByText("Turn on")).toBeTruthy();
  });

  it("reverts the toggle when the save fails", async () => {
    setup(true);
    setMemoryMock.mockRejectedValueOnce(new Error("sidecar down"));

    fireEvent.click(await screen.findByText("Turn off"));

    // Must not claim to be off when the write never landed.
    await waitFor(() => expect(screen.getByText("Turn off")).toBeTruthy());
    expect(screen.getByText("On")).toBeTruthy();
  });
});
