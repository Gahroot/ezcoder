import { PlusIcon } from "@phosphor-icons/react";
import type { ProjectTask, WorkspaceMode } from "./agent";
import { AutopilotToggle } from "./AutopilotToggle";
import { MetalButton } from "./MetalButton";
import { RadioButton } from "./RadioButton";
import { RankBadge } from "./RankBadge";
import { WindowLayoutButton } from "./WindowLayoutButton";
import type { ProgressState } from "./useProgress";

/** The workspace header's right side: rank badge + XP chips and the per-mode action buttons. */
/** A started goal shows either its conversation or its workers at work. */
export type GoalView = "chat" | "workers";

const GOAL_VIEWS: ReadonlyArray<{ view: GoalView; label: string }> = [
  { view: "chat", label: "Chat" },
  { view: "workers", label: "Workers" },
];

export function WorkspaceHeaderActions({
  workspaceMode,
  isGoal = false,
  goalView = null,
  onGoalViewChange,
  goalNeedsAnswer = false,
  progress,
  rankCelebrateNonce,
  xpChips,
  onOpenScorecard,
  windowFocused,
  running,
  autopilot,
  autopilotReviewing,
  onAutopilotChange,
  onNewSession,
  onOpenNotes,
  onOpenMemories,
  projectTasks,
  onOpenTasks,
  showChecklist,
  onOpenChecklist,
  onArrange,
  needsGitInit,
  onInitGit,
  commitCommand,
  hasCommit,
  onCommit,
}: {
  workspaceMode: WorkspaceMode;
  /**
   * A Goal's coordinator window. It is one ongoing conversation, so it drops the
   * per-project tools (Autopilot, New, Notes, Tasks, Checklist, Initialize Git)
   * and keeps only commit.
   */
  isGoal?: boolean;
  /** A started goal's current view; null before the goal starts. */
  goalView?: GoalView | null;
  onGoalViewChange?: (view: GoalView) => void;
  /** GG Goals is waiting on an answer that only the Chat view shows. */
  goalNeedsAnswer?: boolean;
  progress: ProgressState["snapshot"];
  rankCelebrateNonce: string | null;
  xpChips: Array<{ id: string; label: string }>;
  onOpenScorecard: () => void;
  windowFocused: boolean;
  running: boolean;
  autopilot: boolean;
  autopilotReviewing: boolean;
  onAutopilotChange: (next: boolean) => void;
  onNewSession: () => void;
  onOpenNotes: () => void;
  onOpenMemories: () => void;
  projectTasks: ProjectTask[];
  onOpenTasks: () => void;
  showChecklist: boolean;
  onOpenChecklist: () => void;
  onArrange: () => void;
  needsGitInit: boolean;
  onInitGit: () => void;
  commitCommand: string | null;
  hasCommit: boolean;
  onCommit: () => void;
}): React.ReactElement {
  return (
    <>
      <div className="rank-badge-wrap">
        <RankBadge
          snapshot={progress}
          celebrateNonce={rankCelebrateNonce}
          onClick={onOpenScorecard}
        />
        <div className="rank-xp-chip-layer" aria-hidden="true">
          {xpChips.map((chip) => (
            <span className="rank-xp-chip" key={chip.id}>
              {chip.label}
            </span>
          ))}
        </div>
      </div>
      {isGoal ? (
        <span className="picker-head-actions">
          {goalView && onGoalViewChange && (
            <div className="goal-view-switch" role="group" aria-label="Goal view">
              {GOAL_VIEWS.map(({ view, label }) => {
                const attention = view === "chat" && goalView !== "chat" && goalNeedsAnswer;
                return (
                  <button
                    key={view}
                    type="button"
                    className="goal-view-option"
                    aria-pressed={goalView === view}
                    data-attention={attention ? "true" : undefined}
                    aria-label={attention ? `${label}, a question is waiting for you` : undefined}
                    onClick={() => onGoalViewChange(view)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          <RadioButton />
          <WindowLayoutButton onArrange={onArrange} />
          {commitCommand && (
            <MetalButton
              windowFocused={windowFocused}
              className={`btn btn-sm ${hasCommit ? "btn-success" : "btn-ghost"}`}
              disabled={running}
              title={hasCommit ? "Run /commit" : "Generate a /commit command"}
              onClick={onCommit}
            >
              {`/${commitCommand}`}
            </MetalButton>
          )}
        </span>
      ) : workspaceMode !== "code" ? (
        <span className="picker-head-actions">
          <MetalButton
            windowFocused={windowFocused}
            className="btn btn-primary btn-sm"
            disabled={running}
            title={workspaceMode === "motion" ? "Start a new video session" : "Start a new chat"}
            onClick={onNewSession}
          >
            <PlusIcon size={14} aria-hidden="true" />
            New
          </MetalButton>
          <button className="btn btn-sm btn-ghost" title="Open your notes" onClick={onOpenNotes}>
            Notes
          </button>
          {workspaceMode === "chat" && (
            <button
              className="btn btn-sm btn-ghost"
              title="View and curate chat memories and Jiwa"
              onClick={onOpenMemories}
            >
              Brain
            </button>
          )}
          <RadioButton />
          <WindowLayoutButton />
        </span>
      ) : (
        <>
          <span className="picker-head-actions">
            <AutopilotToggle
              checked={autopilot}
              disabled={running || autopilotReviewing}
              onChange={onAutopilotChange}
            />
            {/* Quiet here on purpose: in a project the header's one accent is
                the commit action, so New sits with the other tools. */}
            <button
              className="btn btn-sm btn-ghost"
              disabled={running}
              title="Start a new session for this project"
              onClick={onNewSession}
            >
              <PlusIcon size={14} aria-hidden="true" />
              New
            </button>
            <button
              className="btn btn-sm btn-ghost"
              title="Open your notes for this project"
              onClick={onOpenNotes}
            >
              Notes
            </button>
            <button
              className="btn btn-sm btn-ghost"
              title="View and run this project's tasks"
              onClick={onOpenTasks}
            >
              {projectTasks.some((t) => t.status !== "done")
                ? `Tasks (${projectTasks.filter((t) => t.status !== "done").length})`
                : "Tasks"}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              title="Check this project's health: tests, CI, security, design and more"
              onClick={onOpenChecklist}
              aria-pressed={showChecklist}
            >
              Checklist
            </button>
            <RadioButton />
            <WindowLayoutButton onArrange={onArrange} />
            {needsGitInit ? (
              <button
                className="btn btn-sm btn-ghost"
                disabled={running}
                title="Initialize git + create a GitHub repository"
                onClick={onInitGit}
              >
                {"Initialize Git"}
              </button>
            ) : (
              commitCommand && (
                <MetalButton
                  windowFocused={windowFocused}
                  className={`btn btn-sm ${hasCommit ? "btn-success" : "btn-ghost"}`}
                  disabled={running}
                  title={hasCommit ? "Run /commit" : "Generate a /commit command"}
                  onClick={onCommit}
                >
                  {`/${commitCommand}`}
                </MetalButton>
              )
            )}
          </span>
        </>
      )}
    </>
  );
}
