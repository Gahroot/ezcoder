import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { PencilIcon } from "@phosphor-icons/react";
import { openProjectPath, workspaceProductName, type WorkspaceMode } from "./agent";
import { projectAccent } from "./projectAccent";
import { formatWorkspaceTitle } from "./workspace-title";

interface WorkspaceHeaderProps {
  /** The header element: a Goal's world sits behind it and keeps clear of it. */
  ref?: Ref<HTMLDivElement>;
  workspaceMode: WorkspaceMode;
  cwd?: string;
  /** A Goal window: titled with the goal's name instead of its folder slug. */
  goalName?: string | null;
  /** Feed the title's tooltip: the full project context on hover. */
  gitBranch?: string | null;
  gitDirtyFileCount?: number;
  gitHubIssues?: number | null;
  gitHubPRs?: number | null;
  additionalRoots?: string[];
  /** User-defined window label. Null keeps the project folder as the default. */
  customTitle?: string | null;
  onCustomTitleChange?: (title: string | null) => void;
  /** A short label after the name, e.g. the chat agent ("General"). */
  subtitle?: string | null;
  /** Left of the title, after the traffic lights: the back key. */
  leading?: ReactNode;
  /** Right end: Commit, a Goal's view switch. Always visible. */
  trailing?: ReactNode;
}

/**
 * The workspace's one-row title bar: back, the project's name (its colour mark
 * included) centred, and the actions that must stay visible at any window size
 * on the right. Everything that used to crowd a second row and the strip now
 * reads out from the deck at the bottom of the window.
 */
export function WorkspaceHeader({
  ref,
  workspaceMode,
  cwd,
  goalName = null,
  gitBranch,
  gitDirtyFileCount = 0,
  gitHubIssues = null,
  gitHubPRs = null,
  additionalRoots = [],
  customTitle = null,
  onCustomTitleChange,
  subtitle = null,
  leading,
  trailing,
}: WorkspaceHeaderProps): React.ReactElement {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(customTitle ?? "");
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editingTitle) setTitleDraft(customTitle ?? "");
  }, [customTitle, editingTitle]);

  useEffect(() => {
    if (!editingTitle) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [editingTitle]);

  function commitTitle(): void {
    const nextTitle = titleDraft.trim() || null;
    setEditingTitle(false);
    setTitleDraft(nextTitle ?? "");
    if (nextTitle !== customTitle) onCustomTitleChange?.(nextTitle);
  }

  const fallbackTitle = workspaceProductName(workspaceMode, goalName !== null);
  const directory = goalName ?? cwd?.split(/[\\/]/).filter(Boolean).pop();
  // Stable per-project colour, so a wall of identical windows stays tellable
  // apart at a glance.
  const accent = projectAccent(cwd);

  return (
    <div
      ref={ref}
      className="chat-head"
      style={accent ? ({ "--project-accent": accent } as CSSProperties) : undefined}
    >
      <div className="chat-head-strip" data-tauri-drag-region>
        <div className="chat-head-lead" data-tauri-drag-region>
          {leading}
        </div>
        {/* One tooltip for the whole title: the project's context. The folder
            button inside says what clicking does in its accessible name only,
            so hovering never stacks two tooltips. */}
        <span
          className="chat-head-title"
          data-tauri-drag-region
          title={formatWorkspaceTitle(
            cwd,
            gitBranch,
            fallbackTitle,
            gitDirtyFileCount,
            gitHubIssues,
            gitHubPRs,
            additionalRoots,
            customTitle,
          )}
        >
          {accent && <span className="chat-head-accent-dot" aria-hidden="true" />}
          {directory && editingTitle ? (
            <input
              ref={titleInputRef}
              className="chat-head-title-input"
              value={titleDraft}
              maxLength={80}
              aria-label="Tab name"
              placeholder={directory}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitTitle();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setTitleDraft(customTitle ?? "");
                  setEditingTitle(false);
                }
              }}
            />
          ) : directory ? (
            <button
              type="button"
              className="chat-head-cwd chat-head-link"
              disabled={!cwd}
              aria-label={cwd ? `${customTitle || directory}. Open the folder` : undefined}
              onClick={() => cwd && void openProjectPath(cwd)}
            >
              {customTitle || directory}
            </button>
          ) : (
            <span className="chat-head-cwd" data-tauri-drag-region>
              {fallbackTitle}
            </span>
          )}
          {directory && onCustomTitleChange && !editingTitle && (
            <button
              type="button"
              className="chat-head-rename"
              title="Rename this tab"
              aria-label="Rename this tab"
              onClick={() => setEditingTitle(true)}
            >
              <PencilIcon size={11} weight="bold" aria-hidden="true" />
            </button>
          )}
          {subtitle && (
            <span className="chat-head-sub" data-tauri-drag-region>
              {subtitle}
            </span>
          )}
        </span>
        <div className="chat-head-trail" data-tauri-drag-region>
          {trailing}
        </div>
      </div>
    </div>
  );
}
