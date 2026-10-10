// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  createGoal,
  deleteGoal,
  listGoals,
  selectProject,
  waitForReady,
  type GoalSummary,
} from "./agent";
import { GoalPicker, contextSummary } from "./GoalPicker";

vi.mock("./agent", () => ({
  arrangeAllWindows: vi.fn(),
  focusWindowByOffset: vi.fn(),
  createGoal: vi.fn(),
  deleteGoal: vi.fn(),
  listGoals: vi.fn(),
  selectProject: vi.fn(),
  waitForReady: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./RadioButton", () => ({ RadioButton: () => <button>Radio</button> }));
vi.mock("./WindowLayoutButton", () => ({ WindowLayoutButton: () => <button>Windows</button> }));

const listGoalsMock = vi.mocked(listGoals);
const createGoalMock = vi.mocked(createGoal);
const selectProjectMock = vi.mocked(selectProject);
const openDialogMock = vi.mocked(openDialog);

const GOAL: GoalSummary = {
  id: "api-latency",
  name: "API latency",
  goal: "Bring p95 latency under 200 ms across the whole API",
  context: [
    { path: "/repos/api", kind: "folder" },
    { path: "/repos/web", kind: "folder" },
    { path: "/docs/spec.md", kind: "file" },
  ],
  path: "/Users/dev/.gg/goals/api-latency",
  createdAt: "2026-10-10T12:00:00.000Z",
  lastActiveMs: 1,
  lastActiveDisplay: "2m ago",
  latestSessionPath: "/sessions/goal-1.jsonl",
};

function renderPicker(goals: GoalSummary[]): { onChosen: ReturnType<typeof vi.fn> } {
  vi.mocked(waitForReady).mockResolvedValue();
  listGoalsMock.mockResolvedValue(goals);
  selectProjectMock.mockResolvedValue();
  const onChosen = vi.fn();
  render(<GoalPicker onChosen={onChosen} onClose={vi.fn()} />);
  return { onChosen };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GoalPicker", () => {
  it("lists goals with their total, objective and context, and resumes the latest session", async () => {
    const { onChosen } = renderPicker([GOAL]);

    expect(await screen.findByText("API latency")).toBeDefined();
    expect(screen.getByText("Choose a goal")).toBeDefined();
    expect(screen.getByText("1")).toBeDefined();
    expect(screen.getByText(GOAL.goal)).toBeDefined();
    // The context badge sits with the title, not under it beside the goal text.
    const title = screen.getByText("API latency").parentElement as HTMLElement;
    expect(within(title).getByText("2 folders \u00b7 1 file")).toBeDefined();
    expect(screen.getByText(GOAL.goal).parentElement?.textContent).toBe(GOAL.goal);
    expect(screen.getByRole("textbox", { name: "Search goals" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /^API latency/ }));

    await waitFor(() => expect(onChosen).toHaveBeenCalledWith(GOAL.path));
    expect(selectProjectMock).toHaveBeenCalledWith(GOAL.path, GOAL.latestSessionPath);
  });

  it("deletes a goal after confirming, and keeps it when deleting fails", async () => {
    renderPicker([GOAL]);
    await screen.findByText("API latency");
    vi.mocked(deleteGoal).mockRejectedValueOnce(new Error("This goal is open in another window."));

    fireEvent.click(screen.getByRole("button", { name: "Delete API latency" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("This goal is open in another window.")).toBeDefined();
    expect(screen.getByText("API latency")).toBeDefined();

    vi.mocked(deleteGoal).mockResolvedValueOnce();
    fireEvent.click(screen.getByRole("button", { name: "Delete API latency" }));
    expect(screen.getByText(/attached folders and files are not touched/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText("API latency")).toBeNull());
    expect(deleteGoal).toHaveBeenLastCalledWith("api-latency");
    expect(selectProjectMock).not.toHaveBeenCalled();
  });

  it("filters goals by name or objective", async () => {
    renderPicker([GOAL, { ...GOAL, id: "b", path: "/g/b", name: "Docs", goal: "Rewrite docs" }]);
    await screen.findByText("Docs");

    fireEvent.change(screen.getByRole("textbox", { name: "Search goals" }), {
      target: { value: "p95" },
    });

    expect(screen.queryByText("Docs")).toBeNull();
    expect(screen.getByText("API latency")).toBeDefined();
  });

  it("offers a new goal when there are none, and shows a retry when listing fails", async () => {
    renderPicker([]);
    expect(await screen.findByText(/No goals yet/)).toBeDefined();
    expect(screen.getAllByRole("button", { name: "+ New goal" }).length).toBeGreaterThan(0);
    cleanup();

    vi.mocked(waitForReady).mockResolvedValue();
    listGoalsMock.mockRejectedValueOnce(new Error("down"));
    render(<GoalPicker onChosen={vi.fn()} />);
    expect(await screen.findByText("Couldn't load your goals.")).toBeDefined();
  });

  it("creates a goal with its context and opens it", async () => {
    const { onChosen } = renderPicker([]);
    await screen.findByText(/No goals yet/);
    const created: GoalSummary = { ...GOAL, latestSessionPath: null };
    createGoalMock.mockResolvedValue(created);
    openDialogMock.mockResolvedValue(["/repos/api"]);

    fireEvent.click(screen.getAllByRole("button", { name: "+ New goal" })[0] as HTMLElement);
    const create = screen.getByRole("button", { name: "Create goal" });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByPlaceholderText("Bring p95 latency under 200 ms across the whole API"),
    ).toBeDefined();

    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(name.maxLength).toBe(15);
    fireEvent.change(name, { target: { value: "API latency" } });
    expect(screen.getByText("11/15")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: GOAL.goal } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add folders" }));
    expect(await screen.findByText("api")).toBeDefined();
    expect(openDialogMock).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));

    fireEvent.click(create);

    await waitFor(() => expect(onChosen).toHaveBeenCalledWith(created.path));
    expect(createGoalMock).toHaveBeenCalledWith({
      name: "API latency",
      goal: GOAL.goal,
      context: ["/repos/api"],
    });
    expect(selectProjectMock).toHaveBeenCalledWith(created.path);
  });

  it("keeps the modal open with the sidecar's reason when creating fails", async () => {
    renderPicker([]);
    await screen.findByText(/No goals yet/);
    createGoalMock.mockRejectedValue(new Error("Not found: /gone"));

    fireEvent.click(screen.getAllByRole("button", { name: "+ New goal" })[0] as HTMLElement);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "y" } });
    fireEvent.click(screen.getByRole("button", { name: "Create goal" }));

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.getByText("Not found: /gone")).toBeDefined();
    expect(selectProjectMock).not.toHaveBeenCalled();
  });
});

describe("contextSummary", () => {
  it("is null with no context and pluralises counts", () => {
    expect(contextSummary({ ...GOAL, context: [] })).toBeNull();
    expect(contextSummary({ ...GOAL, context: [{ path: "/a", kind: "file" }] })).toBe("1 file");
  });
});
