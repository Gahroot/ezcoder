// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { arrangeAllWindows, setupWindows, showPage, windowPages } from "./agent";
import { WindowLayoutButton } from "./WindowLayoutButton";

vi.mock("./agent", () => ({
  arrangeAllWindows: vi.fn().mockResolvedValue(undefined),
  setupWindows: vi.fn().mockResolvedValue(undefined),
  listMonitors: vi.fn().mockResolvedValue({ monitors: [], selected: null }),
  setTargetMonitor: vi.fn().mockResolvedValue(undefined),
  showPage: vi.fn().mockResolvedValue(undefined),
  windowPages: vi.fn().mockResolvedValue({ current: 1, pages: 1 }),
}));
vi.mock("./sounds", () => ({ playSound: vi.fn() }));

beforeEach(() => {
  document.documentElement.className = "platform-windows";
  vi.clearAllMocks();
  // Cleared mocks lose their resolved value; the component awaits both.
  vi.mocked(windowPages).mockResolvedValue({ current: 1, pages: 1 });
  vi.mocked(showPage).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  document.documentElement.className = "";
});

describe("WindowLayoutButton (Windows/Linux fallback)", () => {
  it("commits a window count from the in-webview menu", async () => {
    const onArrange = vi.fn();
    render(<WindowLayoutButton onArrange={onArrange} />);

    fireEvent.click(screen.getByRole("button", { name: "Arrange into multiple project windows" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "4 windows" }));

    await waitFor(() => expect(setupWindows).toHaveBeenCalledWith(4));
    expect(onArrange).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("runs auto-arrange from the fallback menu", async () => {
    render(<WindowLayoutButton />);

    fireEvent.click(screen.getByRole("button", { name: "Arrange into multiple project windows" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Auto-arrange all" }));

    await waitFor(() => expect(arrangeAllWindows).toHaveBeenCalledOnce());
    expect(setupWindows).not.toHaveBeenCalled();
  });

  it("renders the menu outside the app stacking context", async () => {
    const { container } = render(<WindowLayoutButton />);
    fireEvent.click(screen.getByRole("button", { name: /arrange into multiple project windows/i }));

    const menu = screen.getByRole("menu", { name: /window layout/i });
    await waitFor(() => expect(menu.parentElement).toBe(document.body));
    expect(container.contains(menu)).toBe(false);
  });

  it("commits the 12-window layout, which spans two pages", async () => {
    render(<WindowLayoutButton />);

    fireEvent.click(screen.getByRole("button", { name: "Arrange into multiple project windows" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /12 windows/ }));

    await waitFor(() => expect(setupWindows).toHaveBeenCalledWith(12));
  });

  it("hides the page rows while everything fits on one page", async () => {
    render(<WindowLayoutButton />);
    fireEvent.click(screen.getByRole("button", { name: "Arrange into multiple project windows" }));

    // Wait for the resolved page count to be APPLIED, not merely requested:
    // asserting the absence of Page rows right after the click would pass
    // vacuously, before `windowPages()` resolves, even if the gate were broken.
    await act(async () => {});
    expect(windowPages).toHaveBeenCalled();
    expect(screen.queryByRole("menuitem", { name: /Page 1/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Page 2/ })).toBeNull();
  });

  it("switches page from the page rows once a second page exists", async () => {
    vi.mocked(windowPages).mockResolvedValue({ current: 1, pages: 2 });
    render(<WindowLayoutButton />);
    fireEvent.click(screen.getByRole("button", { name: "Arrange into multiple project windows" }));

    const page2 = await screen.findByRole("menuitem", { name: /Page 2/ });
    fireEvent.click(page2);

    await waitFor(() => expect(showPage).toHaveBeenCalledWith(2));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("names the page shortcut with Ctrl, not the mac Command key", async () => {
    // This suite runs as platform-windows; ⌘ would name a key absent from the
    // keyboard. App.tsx binds `metaKey || ctrlKey`, so Ctrl+2 is correct here.
    vi.mocked(windowPages).mockResolvedValue({ current: 1, pages: 2 });
    render(<WindowLayoutButton />);
    fireEvent.click(screen.getByRole("button", { name: "Arrange into multiple project windows" }));

    const page2 = await screen.findByRole("menuitem", { name: /Page 2/ });
    expect(page2.textContent).toContain("Ctrl+2");
    expect(page2.textContent).not.toContain("\u2318");
  });

  it("names the page shortcut with Command on macOS", async () => {
    document.documentElement.className = "platform-macos";
    vi.mocked(windowPages).mockResolvedValue({ current: 1, pages: 2 });
    render(<WindowLayoutButton />);
    fireEvent.click(screen.getByRole("button", { name: "Arrange into multiple project windows" }));

    const page2 = await screen.findByRole("menuitem", { name: /Page 2/ });
    expect(page2.textContent).toContain("\u23182");
  });
});
