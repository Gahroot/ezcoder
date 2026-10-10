// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceHeaderActions, type GoalView } from "./WorkspaceHeaderActions";

vi.mock("./RadioButton", () => ({ RadioButton: () => <button>Radio</button> }));
vi.mock("./WindowLayoutButton", () => ({ WindowLayoutButton: () => <button>Windows</button> }));
vi.mock("./RankBadge", () => ({ RankBadge: () => null }));
vi.mock("./AutopilotToggle", () => ({ AutopilotToggle: () => <button>Autopilot</button> }));

function renderActions(
  isGoal: boolean,
  needsGitInit = false,
  goalView: GoalView | null = null,
  onGoalViewChange = vi.fn(),
  goalNeedsAnswer = false,
): void {
  render(
    <WorkspaceHeaderActions
      workspaceMode="code"
      isGoal={isGoal}
      goalView={goalView}
      onGoalViewChange={onGoalViewChange}
      goalNeedsAnswer={goalNeedsAnswer}
      progress={null}
      rankCelebrateNonce={null}
      xpChips={[]}
      onOpenScorecard={vi.fn()}
      windowFocused
      running={false}
      autopilot={false}
      autopilotReviewing={false}
      onAutopilotChange={vi.fn()}
      onNewSession={vi.fn()}
      onOpenNotes={vi.fn()}
      onOpenMemories={vi.fn()}
      projectTasks={[]}
      onOpenTasks={vi.fn()}
      showChecklist={false}
      onOpenChecklist={vi.fn()}
      onArrange={vi.fn()}
      needsGitInit={needsGitInit}
      onInitGit={vi.fn()}
      commitCommand="commit"
      hasCommit
      onCommit={vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe("WorkspaceHeaderActions", () => {
  it("keeps only Radio, Windows and commit in a Goal window", () => {
    // A goal folder is not a git repo; commit still shows, Initialize Git never does.
    renderActions(true, true);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Radio",
      "Windows",
      "/commit",
    ]);
  });

  it("switches a started goal between Chat and Workers", () => {
    const change = vi.fn();
    renderActions(true, false, "workers", change);
    const group = screen.getByRole("group", { name: "Goal view" });
    expect(group.textContent).toBe("ChatWorkers");
    expect(screen.getByRole("button", { name: "Workers" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(change).toHaveBeenLastCalledWith("chat");
  });

  it("flags Chat while a question waits there, but not when Chat is open", () => {
    renderActions(true, false, "workers", vi.fn(), true);
    const chat = screen.getByRole("button", { name: "Chat, a question is waiting for you" });
    expect(chat.getAttribute("data-attention")).toBe("true");
    cleanup();
    renderActions(true, false, "chat", vi.fn(), true);
    expect(screen.getByRole("button", { name: "Chat" }).getAttribute("data-attention")).toBeNull();
  });

  it("has no view switch before the goal starts", () => {
    renderActions(true);
    expect(screen.queryByRole("group", { name: "Goal view" })).toBeNull();
  });

  it("still shows the full project toolset in a code window", () => {
    renderActions(false);
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    for (const label of ["Autopilot", "New", "Notes", "Tasks", "Checklist", "/commit"]) {
      expect(labels).toContain(label);
    }
  });
});
