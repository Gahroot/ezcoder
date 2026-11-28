// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { getFleetActivity, getFleetLog, type FleetActivity } from "./agent";
import { FleetActivityButton } from "./FleetActivityButton";

vi.mock("./agent", () => ({
  getFleetActivity: vi.fn(),
  getFleetLog: vi.fn(),
}));

const logMock = vi.mocked(getFleetLog);
const activityMock = vi.mocked(getFleetActivity);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ACTIVITY: FleetActivity = {
  jobs: [
    {
      id: "fj1",
      name: "e2e",
      kind: "test",
      state: "running",
      node: "gpu-box",
      updatedAt: "2026-11-27T10:00:00.000Z",
    },
    {
      id: "fj2",
      name: "build",
      kind: "build",
      state: "queued",
      updatedAt: "2026-11-27T10:00:00.000Z",
    },
    {
      id: "fj3",
      name: "old",
      kind: "test",
      state: "passed",
      node: "gpu-box",
      updatedAt: "2026-11-27T09:00:00.000Z",
    },
  ],
  services: [
    {
      id: "s1",
      name: "ollama",
      kind: "inference",
      state: "running",
      node: "gpu-box",
      endpoints: [],
    },
    { id: "s2", name: "gone", kind: "browser", state: "stopped", node: "gpu-box", endpoints: [] },
  ],
};

describe("FleetActivityButton", () => {
  it("is hidden while nothing runs on other machines", () => {
    render(<FleetActivityButton activity={{ jobs: [ACTIVITY.jobs[2]!], services: [] }} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("lists live jobs and services with their state and machine", () => {
    render(<FleetActivityButton activity={ACTIVITY} />);
    fireEvent.click(screen.getByRole("button", { name: "3 on other machines" }));
    const dialog = screen.getByRole("dialog", { name: "On other machines" });
    expect(dialog.textContent).toContain("2 jobs \u00b7 1 service");
    expect(dialog.textContent).toContain("Running on gpu-box");
    expect(dialog.textContent).toContain("Waiting for a machine");
    expect(dialog.textContent).not.toContain("old");
    expect(dialog.textContent).not.toContain("gone");
  });

  it("opens the last lines of a job's or service's log", async () => {
    logMock.mockResolvedValueOnce("line 1\nline 2").mockResolvedValueOnce("svc up");
    render(<FleetActivityButton activity={ACTIVITY} />);
    fireEvent.click(screen.getByRole("button", { name: "3 on other machines" }));
    fireEvent.click(screen.getByRole("button", { name: "View log of e2e" }));
    expect((await screen.findByLabelText("Log")).textContent).toBe("line 1\nline 2");
    expect(logMock).toHaveBeenCalledWith("job", "fj1", 200);
    fireEvent.click(screen.getAllByRole("button", { name: "Close" }).slice(-1)[0]!);
    fireEvent.click(screen.getByRole("button", { name: "3 on other machines" }));
    fireEvent.click(screen.getByRole("button", { name: "View log of ollama" }));
    expect((await screen.findByLabelText("Log")).textContent).toBe("svc up");
    expect(logMock).toHaveBeenLastCalledWith("service", "s1", 200);
  });

  it("polls the project's fleet activity when none is given", async () => {
    activityMock.mockResolvedValue(ACTIVITY);
    render(<FleetActivityButton />);
    expect(await screen.findByRole("button", { name: "3 on other machines" })).toBeTruthy();
  });
});
