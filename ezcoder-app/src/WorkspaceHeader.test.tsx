// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// WorkspaceHeader imports agent.ts (openProjectPath), which reads the current
// webview window at module load — stub it for jsdom.
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    setTitle: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { WorkspaceHeader } from "./WorkspaceHeader";
import { formatWorkspaceTitle } from "./workspace-title";

afterEach(cleanup);

describe("WorkspaceHeader", () => {
  it("is one row: back, the title, and the trailing actions", () => {
    const { container } = render(
      <WorkspaceHeader
        workspaceMode="chat"
        subtitle="General"
        leading={<button>Back</button>}
        trailing={<button>Commit</button>}
      />,
    );

    expect(screen.getByText("EZ Chat")).toBeDefined();
    expect(screen.getByText("General")).toBeDefined();
    expect(screen.getByRole("button", { name: "Back" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Commit" })).toBeDefined();
    expect(container.querySelectorAll(".chat-head > *")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /nav buttons/ })).toBeNull();
  });

  it("formats clean, dirty, and pre-commit project context for the tooltip", () => {
    expect(formatWorkspaceTitle("/work/app", "main", "EZ Coder")).toBe("app · main");
    expect(formatWorkspaceTitle("/work/app", "main", "EZ Coder", 3)).toBe(
      "app · main · 3 uncommitted",
    );
    expect(formatWorkspaceTitle("/work/app", null, "EZ Coder", 1)).toBe("app · 1 uncommitted");
    expect(formatWorkspaceTitle("/work/app", "main", "EZ Coder", 0, 4, 1)).toBe(
      "app · main · 4 issues · 1 PR",
    );
    expect(formatWorkspaceTitle("/work/app", "main", "EZ Coder", 0, 3, 0)).toBe(
      "app · main · 3 issues",
    );
    expect(
      formatWorkspaceTitle("/work/app", "main", "EZ Coder", 0, null, null, ["/work/sdk"]),
    ).toBe("app · +1 root · main");
  });

  it("names the window after its folder, which opens on click, with the full context on hover", () => {
    render(
      <WorkspaceHeader
        workspaceMode="code"
        cwd={"C:\\work\\ezcoder"}
        gitBranch="feature/titlebar"
        gitDirtyFileCount={3}
      />,
    );

    const folder = screen.getByRole("button", { name: "ezcoder. Open the folder" });
    // One tooltip only: the title's, never a second on the folder button.
    expect(folder.getAttribute("title")).toBeNull();
    expect(screen.getByTitle("ezcoder · feature/titlebar · 3 uncommitted")).toBeDefined();
    expect(screen.queryByText("EZ Coder")).toBeNull();
  });

  it("titles a Goal window with the goal's name", () => {
    render(<WorkspaceHeader workspaceMode="code" cwd="/work/goal-x" goalName="Ship the deck" />);
    expect(screen.getByRole("button", { name: "Ship the deck. Open the folder" })).toBeDefined();
  });

  it("renames the active tab and restores the project-name default when cleared", () => {
    function RenameHarness(): React.ReactElement {
      const [customTitle, setCustomTitle] = useState<string | null>(null);
      return (
        <WorkspaceHeader
          workspaceMode="code"
          cwd="/work/ezcoder"
          customTitle={customTitle}
          onCustomTitleChange={setCustomTitle}
        />
      );
    }

    render(<RenameHarness />);
    expect(screen.getByRole("button", { name: "ezcoder. Open the folder" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Rename this tab" }));
    const input = screen.getByRole("textbox", { name: "Tab name" });
    fireEvent.change(input, { target: { value: "Auth cleanup" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Auth cleanup. Open the folder" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Rename this tab" }));
    const renamedInput = screen.getByRole("textbox", { name: "Tab name" });
    fireEvent.change(renamedInput, { target: { value: "  " } });
    fireEvent.keyDown(renamedInput, { key: "Enter" });
    expect(screen.getByRole("button", { name: "ezcoder. Open the folder" })).toBeDefined();
    expect(formatWorkspaceTitle("/work/ezcoder", "main", "EZ Coder", 0, null, null, [], "QA")).toBe(
      "QA · main",
    );
  });
});
