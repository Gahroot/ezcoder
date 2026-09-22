// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  getSettings,
  importTranscript,
  listProjects,
  listSessions,
  selectProject,
  projectOpenWindows,
  createWorktree,
  listWorktrees,
  removeWorktree,
  setProjectHidden,
  waitForReady,
  type DiscoveredProject,
  type RecentSession,
} from "./agent";
import { ProjectPicker } from "./ProjectPicker";

vi.mock("./agent", () => ({
  arrangeAllWindows: vi.fn(),
  focusWindowByOffset: vi.fn(),
  getSettings: vi.fn(),
  importTranscript: vi.fn(),
  listProjects: vi.fn(),
  listSessions: vi.fn(),
  selectProject: vi.fn(),
  projectOpenWindows: vi.fn(),
  createWorktree: vi.fn(),
  listWorktrees: vi.fn(),
  removeWorktree: vi.fn(),
  setProjectHidden: vi.fn(),
  waitForReady: vi.fn(),
}));
vi.mock("./RadioButton", () => ({ RadioButton: () => <button>Radio</button> }));
vi.mock("./WindowLayoutButton", () => ({ WindowLayoutButton: () => <button>Windows</button> }));
vi.mock("./NewProjectModal", () => ({ NewProjectModal: () => null }));

const getSettingsMock = vi.mocked(getSettings);
const importTranscriptMock = vi.mocked(importTranscript);
const listProjectsMock = vi.mocked(listProjects);
const listSessionsMock = vi.mocked(listSessions);
const selectProjectMock = vi.mocked(selectProject);
const projectOpenWindowsMock = vi.mocked(projectOpenWindows);
const createWorktreeMock = vi.mocked(createWorktree);
const listWorktreesMock = vi.mocked(listWorktrees);
const removeWorktreeMock = vi.mocked(removeWorktree);
const setProjectHiddenMock = vi.mocked(setProjectHidden);
const waitForReadyMock = vi.mocked(waitForReady);

const PROJECT: DiscoveredProject = {
  name: "ui-test",
  path: "/Users/dev/ui-test",
  lastActiveDisplay: "1w ago",
  sources: ["claude-code"],
};

const NATIVE_SESSION: RecentSession = {
  id: "ez-1",
  path: "/sessions/ez-1.jsonl",
  preview: "Native EZ Coder session",
  lastActiveDisplay: "2m ago",
  messageCount: 4,
};

const FOREIGN_SESSION: RecentSession = {
  id: "cc-1",
  path: "/Users/dev/.claude/projects/-Users-dev-ui-test/cc-1.jsonl",
  preview: "Build a UI dashboard in HTML",
  lastActiveDisplay: "1w ago",
  messageCount: 44,
  source: "claude-code",
};

/** Render the picker already opened on the project's session list. */
async function renderSessionList(sessions: RecentSession[]): Promise<void> {
  getSettingsMock.mockResolvedValue({ projectsRoot: "/Users/dev", configured: true });
  waitForReadyMock.mockResolvedValue();
  listProjectsMock.mockResolvedValue([PROJECT]);
  listSessionsMock.mockResolvedValue(sessions);
  selectProjectMock.mockResolvedValue();
  // No other window holds this project, so opening proceeds without a prompt.
  projectOpenWindowsMock.mockResolvedValue([]);

  render(<ProjectPicker onChosen={vi.fn()} initialProjectPath={PROJECT.path} />);
  await screen.findByText(sessions[0]!.preview);
}

// Default: no separate copies. Set in beforeEach rather than in
// renderSessionList, which runs AFTER a test's own setup and would overwrite it.
beforeEach(() => {
  listWorktreesMock.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const OTHER_PROJECT: DiscoveredProject = {
  name: "scratch",
  path: "/private/tmp",
  lastActiveDisplay: "1d ago",
  sources: ["ezcoder"],
};

/** Render the picker on the project list (no deep link). */
async function renderProjectList(projects: DiscoveredProject[]): Promise<void> {
  getSettingsMock.mockResolvedValue({ projectsRoot: "/Users/dev", configured: true });
  waitForReadyMock.mockResolvedValue();
  listProjectsMock.mockResolvedValue(projects);

  render(<ProjectPicker onChosen={vi.fn()} />);
  await screen.findByText(projects[0]!.name);
}

describe("ProjectPicker hide", () => {
  it("removes the row and persists the decision", async () => {
    setProjectHiddenMock.mockResolvedValue();
    await renderProjectList([PROJECT, OTHER_PROJECT]);

    fireEvent.click(screen.getByLabelText("Hide scratch"));

    await waitFor(() => expect(screen.queryByText("scratch")).toBeNull());
    expect(setProjectHiddenMock).toHaveBeenCalledWith("/private/tmp", true);
    // The untouched project stays put.
    expect(screen.getByText("ui-test")).toBeTruthy();
  });

  it("restores the row in place when persisting fails", async () => {
    setProjectHiddenMock.mockRejectedValue(new Error("disk full"));
    await renderProjectList([PROJECT, OTHER_PROJECT]);

    fireEvent.click(screen.getByLabelText("Hide ui-test"));

    // Comes back rather than lying about what the next launch will show, and
    // returns to its original position rather than the end of the list.
    await waitFor(() => expect(screen.getByText("ui-test")).toBeTruthy());
    const names = screen.getAllByText(/^(ui-test|scratch)$/).map((n) => n.textContent);
    expect(names).toEqual(["ui-test", "scratch"]);
  });
});

describe("ProjectPicker session list", () => {
  it("badges a Claude Code session with its source", async () => {
    await renderSessionList([NATIVE_SESSION, FOREIGN_SESSION]);

    // The foreign row is labelled; the native one carries no source tag.
    const badge = screen.getByText("Claude Code");
    expect(badge.className).toContain("picker-source-tag");

    const foreignRow = screen.getByText(FOREIGN_SESSION.preview).closest("button");
    expect(foreignRow?.textContent).toContain("Claude Code");
    expect(foreignRow?.getAttribute("title")).toContain("opens as a EZ Coder session");

    const nativeRow = screen.getByText(NATIVE_SESSION.preview).closest("button");
    expect(nativeRow?.textContent).not.toContain("Claude Code");
    expect(nativeRow?.getAttribute("title")).toBeNull();
  });

  it("imports then opens when a foreign session is clicked", async () => {
    importTranscriptMock.mockResolvedValue({
      ok: true,
      sessionId: "imported-1",
      sessionPath: "/sessions/imported-1.jsonl",
      cwd: PROJECT.path,
      format: "claude",
      messageCount: 44,
      dropped: "nothing",
    });
    await renderSessionList([FOREIGN_SESSION]);

    fireEvent.click(screen.getByText(FOREIGN_SESSION.preview));

    await waitFor(() => {
      // Imported from the foreign transcript...
      expect(importTranscriptMock).toHaveBeenCalledWith(FOREIGN_SESSION.path, PROJECT.path);
      // ...then opened by the NEW session path, not the transcript path.
      expect(selectProjectMock).toHaveBeenCalledWith(PROJECT.path, "/sessions/imported-1.jsonl");
    });
  });

  it("opens a native session directly, with no import", async () => {
    await renderSessionList([NATIVE_SESSION]);

    fireEvent.click(screen.getByText(NATIVE_SESSION.preview));

    await waitFor(() => {
      expect(selectProjectMock).toHaveBeenCalledWith(PROJECT.path, NATIVE_SESSION.path);
    });
    expect(importTranscriptMock).not.toHaveBeenCalled();
  });

  // Two agents in one working tree overwrite each other's edits, so a project
  // already open elsewhere must not open silently.
  describe("when the project is open in another window", () => {
    const OTHER = [{ label: "project-2", title: "ui-test" }];

    it("asks instead of opening straight away", async () => {
      await renderSessionList([NATIVE_SESSION]);
      projectOpenWindowsMock.mockResolvedValue(OTHER);

      fireEvent.click(screen.getByText(NATIVE_SESSION.preview));

      await screen.findByText(/already open/i);
      expect(selectProjectMock).not.toHaveBeenCalled();
    });

    it("opens the isolated worktree, not the shared project, when isolating", async () => {
      const worktree = "/Users/dev/.ezcoder/worktrees/ui-test/ez-abc";
      createWorktreeMock.mockResolvedValue({
        path: worktree,
        branch: "ez/abc",
        baseRef: "main",
        setup: { carried: [".env"], installs: [{ command: "pnpm install", ok: true }], ok: true },
      });
      await renderSessionList([NATIVE_SESSION]);
      projectOpenWindowsMock.mockResolvedValue(OTHER);

      fireEvent.click(screen.getByText(NATIVE_SESSION.preview));
      fireEvent.click(await screen.findByText("Own copy"));

      await waitFor(() => {
        expect(createWorktreeMock).toHaveBeenCalledWith(PROJECT.path, undefined);
        // The worktree is a fresh checkout: the old session must NOT follow it.
        expect(selectProjectMock).toHaveBeenCalledWith(worktree, undefined);
      });
    });

    it("opens the shared project with its session when the user declines", async () => {
      await renderSessionList([NATIVE_SESSION]);
      projectOpenWindowsMock.mockResolvedValue(OTHER);

      fireEvent.click(screen.getByText(NATIVE_SESSION.preview));
      fireEvent.click(await screen.findByText("Open anyway"));

      await waitFor(() => {
        expect(selectProjectMock).toHaveBeenCalledWith(PROJECT.path, NATIVE_SESSION.path);
      });
      expect(createWorktreeMock).not.toHaveBeenCalled();
    });

    it("keeps the prompt open and shows why when the worktree cannot be made", async () => {
      createWorktreeMock.mockRejectedValue(new Error("Not a git repository: /Users/dev/ui-test"));
      await renderSessionList([NATIVE_SESSION]);
      projectOpenWindowsMock.mockResolvedValue(OTHER);

      fireEvent.click(screen.getByText(NATIVE_SESSION.preview));
      fireEvent.click(await screen.findByText("Own copy"));

      await screen.findByText(/not a git repository/i);
      expect(selectProjectMock).not.toHaveBeenCalled();
    });

    // The copy exists, so this is not a failure to report and throw away: the
    // user chooses between a copy they must install by hand and the shared
    // folder. Opening an agent into a tree that cannot build wastes a session.
    it("waits for the user when the copy was made but its install failed", async () => {
      const worktree = "/Users/dev/.ezcoder/worktrees/ui-test/ez-abc";
      createWorktreeMock.mockResolvedValue({
        path: worktree,
        branch: "ez/abc",
        baseRef: "main",
        setup: {
          carried: [],
          installs: [
            { command: "pnpm install", ok: false, message: "ERR_PNPM_NO_MATCHING_VERSION" },
          ],
          ok: false,
        },
      });
      await renderSessionList([NATIVE_SESSION]);
      projectOpenWindowsMock.mockResolvedValue(OTHER);

      fireEvent.click(screen.getByText(NATIVE_SESSION.preview));
      fireEvent.click(await screen.findByText("Own copy"));

      await screen.findByText(/didn.t finish/i);
      expect(selectProjectMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText("Open the copy"));
      await waitFor(() => expect(selectProjectMock).toHaveBeenCalledWith(worktree, undefined));
    });
  });

  // Copies holding nothing are reclaimed automatically on window close, so any
  // copy the user actually sees here is one that needs a decision.
  describe("the list of separate copies", () => {
    const EMPTY_COPY = {
      path: "/Users/dev/.ezcoder/worktrees/ui-test/spare",
      branch: "spare",
      baseRef: "main",
      dirtyFiles: 0,
      commitsAhead: 0,
      merged: true,
      busy: false,
      reclaimable: true,
      blockedBy: [],
    };
    const COPY_WITH_WORK = {
      ...EMPTY_COPY,
      path: "/Users/dev/.ezcoder/worktrees/ui-test/feature",
      branch: "feature",
      dirtyFiles: 2,
      commitsAhead: 3,
      merged: false,
      reclaimable: false,
      blockedBy: ["it has 2 uncommitted file(s)", "it has 3 unmerged commit(s)"],
    };

    it("stays out of the way when there are no copies", async () => {
      await renderSessionList([NATIVE_SESSION]);
      expect(screen.queryByText(/separate copies/i)).toBeNull();
    });

    it("says what each copy is holding", async () => {
      listWorktreesMock.mockResolvedValue([COPY_WITH_WORK]);
      await renderSessionList([NATIVE_SESSION]);

      await screen.findByText(/separate copies/i);
      // Plain language, not git's: "unsaved" and "unmerged", never "dirty HEAD".
      await screen.findByText(/2 unsaved files/i);
      expect(screen.getByText(/3 unmerged changes/i)).not.toBeNull();
    });

    it("cleans up an empty copy on one click, without forcing", async () => {
      listWorktreesMock.mockResolvedValue([EMPTY_COPY]);
      removeWorktreeMock.mockResolvedValue({ existed: true, freed: true, branchDeleted: true });
      await renderSessionList([NATIVE_SESSION]);

      fireEvent.click(await screen.findByText("Clean up"));

      await waitFor(() => {
        expect(removeWorktreeMock).toHaveBeenCalledWith(PROJECT.path, EMPTY_COPY.path, false);
      });
    });

    it("never deletes work on a single click", async () => {
      listWorktreesMock.mockResolvedValue([COPY_WITH_WORK]);
      await renderSessionList([NATIVE_SESSION]);

      fireEvent.click(await screen.findByText("Clean up"));

      // First click only asks; nothing has been removed.
      await screen.findByText("Keep it");
      expect(removeWorktreeMock).not.toHaveBeenCalled();

      // The confirm names what is lost, so the second click is informed.
      fireEvent.click(screen.getByText(/Delete 2 unsaved files/i));
      await waitFor(() => {
        expect(removeWorktreeMock).toHaveBeenCalledWith(PROJECT.path, COPY_WITH_WORK.path, true);
      });
    });

    it("will not offer to remove a copy another window is working in", async () => {
      listWorktreesMock.mockResolvedValue([
        { ...COPY_WITH_WORK, busy: true, blockedBy: ["it is open in another window"] },
      ]);
      await renderSessionList([NATIVE_SESSION]);

      // Forcing here would pull the folder out from under a live agent.
      expect((await screen.findByText("Clean up")) as HTMLButtonElement).toHaveProperty(
        "disabled",
        true,
      );
    });
  });

  it("surfaces a failed import instead of opening a broken session", async () => {
    importTranscriptMock.mockResolvedValue({ ok: false, error: "Could not read transcript" });
    await renderSessionList([FOREIGN_SESSION]);

    fireEvent.click(screen.getByText(FOREIGN_SESSION.preview));

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.getByRole("alert").textContent).toContain("Could not read transcript");
    expect(selectProjectMock).not.toHaveBeenCalled();
  });

  it("stays usable after a failed import", async () => {
    importTranscriptMock.mockRejectedValue(new Error("daemon not ready"));
    await renderSessionList([FOREIGN_SESSION]);

    fireEvent.click(screen.getByText(FOREIGN_SESSION.preview));
    await screen.findByRole("alert");

    // `busy` must be released, or every later click is silently ignored.
    const row = screen.getByText(FOREIGN_SESSION.preview).closest("button");
    expect(row?.hasAttribute("disabled")).toBe(false);
  });
});
