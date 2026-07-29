import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pencil } from "lucide-react";
import { openProjectPath, openUrl, type WorkspaceMode } from "./agent";

interface WorkspaceHeaderProps {
  workspaceMode: WorkspaceMode;
  cwd?: string;
  gitBranch?: string | null;
  gitDirtyFileCount?: number;
  /** Open issue/PR counts for the project's GitHub origin (null = unknown/hidden). */
  gitHubIssues?: number | null;
  gitHubPRs?: number | null;
  /** Origin repo's web URL — makes the issue/PR chips clickable. */
  gitHubRepoUrl?: string | null;
  /** Extra workspace roots added with /add-dir. */
  additionalRoots?: string[];
  /** User-defined window label. Null keeps the project folder as the default. */
  customTitle?: string | null;
  onCustomTitleChange?: (title: string | null) => void;
  navHidden: boolean;
  onToggleNav: () => void;
  stripExtras?: ReactNode;
  children: ReactNode;
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function formatWorkspaceTitle(
  cwd: string | undefined,
  gitBranch: string | null | undefined,
  fallback: string,
  gitDirtyFileCount = 0,
  gitHubIssues: number | null = null,
  gitHubPRs: number | null = null,
  additionalRoots: string[] = [],
  customTitle: string | null = null,
): string {
  const directory = cwd?.split(/[\\/]/).filter(Boolean).pop();
  if (!directory) return fallback;
  const segments = [customTitle?.trim() || directory];
  if (additionalRoots.length > 0)
    segments.push(`+${pluralize(additionalRoots.length, "root", "roots")}`);
  if (gitBranch) segments.push(`⎇ ${gitBranch}`);
  if (gitDirtyFileCount > 0) segments.push(`${gitDirtyFileCount} uncommitted`);
  if (gitHubIssues !== null && gitHubIssues > 0)
    segments.push(pluralize(gitHubIssues, "issue", "issues"));
  if (gitHubPRs !== null && gitHubPRs > 0) segments.push(pluralize(gitHubPRs, "PR", "PRs"));
  return segments.join(" │ ");
}

/** Shared code/chat titlebar and collapsible workspace navigation. */
export function WorkspaceHeader({
  workspaceMode,
  cwd,
  gitBranch,
  gitDirtyFileCount = 0,
  gitHubIssues = null,
  gitHubPRs = null,
  gitHubRepoUrl = null,
  additionalRoots = [],
  customTitle = null,
  onCustomTitleChange,
  navHidden,
  onToggleNav,
  stripExtras,
  children,
}: WorkspaceHeaderProps): React.ReactElement {
  const fallbackTitle = workspaceMode === "chat" ? "EZ Chat" : "EZ Coder";
  const directory = cwd?.split(/[\\/]/).filter(Boolean).pop();
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

  return (
    <div className="chat-head">
      <div className="chat-head-strip" data-tauri-drag-region>
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
          {directory ? (
            <>
              {editingTitle ? (
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
              ) : (
                <button
                  type="button"
                  className="chat-head-cwd chat-head-link"
                  disabled={!cwd}
                  title={cwd ? `${cwd} — open folder` : undefined}
                  onClick={() => cwd && void openProjectPath(cwd)}
                >
                  {customTitle || directory}
                </button>
              )}
              {onCustomTitleChange && !editingTitle && (
                <button
                  type="button"
                  className="chat-head-rename"
                  title="Rename this tab"
                  aria-label="Rename this tab"
                  onClick={() => setEditingTitle(true)}
                >
                  <Pencil size={11} strokeWidth={2} aria-hidden="true" />
                </button>
              )}
              {gitBranch && (
                <>
                  <span className="chat-head-sep" data-tauri-drag-region>
                    {"│"}
                  </span>
                  {gitHubRepoUrl ? (
                    <button
                      type="button"
                      className="chat-head-branch chat-head-link"
                      title={`${gitBranch} — open ${gitHubRepoUrl} on GitHub`}
                      onClick={() => void openUrl(gitHubRepoUrl)}
                    >
                      {`⎇ ${gitBranch}`}
                    </button>
                  ) : (
                    <span className="chat-head-branch" data-tauri-drag-region>
                      {`⎇ ${gitBranch}`}
                    </span>
                  )}
                </>
              )}
              {additionalRoots.length > 0 && (
                <>
                  <span className="chat-head-sep" data-tauri-drag-region>
                    {"│"}
                  </span>
                  <span
                    className="chat-head-dirty"
                    data-tauri-drag-region
                    title={`Additional workspace roots:\n${additionalRoots.join("\n")}`}
                  >
                    {`+${pluralize(additionalRoots.length, "root", "roots")}`}
                  </span>
                </>
              )}
              {gitDirtyFileCount > 0 && (
                <>
                  <span className="chat-head-sep" data-tauri-drag-region>
                    {"│"}
                  </span>
                  <span
                    className="chat-head-dirty"
                    data-tauri-drag-region
                    title={`${gitDirtyFileCount} file${gitDirtyFileCount === 1 ? "" : "s"} not committed`}
                  >
                    {`${gitDirtyFileCount} uncommitted`}
                  </span>
                </>
              )}
              {gitHubIssues !== null && gitHubIssues > 0 && (
                <>
                  <span className="chat-head-sep" data-tauri-drag-region>
                    {"│"}
                  </span>
                  <button
                    type="button"
                    className="chat-head-github"
                    disabled={!gitHubRepoUrl}
                    title={`${pluralize(gitHubIssues, "open issue", "open issues")} on GitHub${gitHubRepoUrl ? " — click to view" : ""}`}
                    onClick={() => gitHubRepoUrl && void openUrl(`${gitHubRepoUrl}/issues`)}
                  >
                    {pluralize(gitHubIssues, "issue", "issues")}
                  </button>
                </>
              )}
              {gitHubPRs !== null && gitHubPRs > 0 && (
                <>
                  <span className="chat-head-sep" data-tauri-drag-region>
                    {"│"}
                  </span>
                  <button
                    type="button"
                    className="chat-head-github"
                    disabled={!gitHubRepoUrl}
                    title={`${pluralize(gitHubPRs, "open PR", "open PRs")} on GitHub${gitHubRepoUrl ? " — click to view" : ""}`}
                    onClick={() => gitHubRepoUrl && void openUrl(`${gitHubRepoUrl}/pulls`)}
                  >
                    {pluralize(gitHubPRs, "PR", "PRs")}
                  </button>
                </>
              )}
            </>
          ) : (
            fallbackTitle
          )}
        </span>
        {stripExtras}
        <button
          className="nav-toggle"
          title={navHidden ? "Show nav buttons" : "Hide nav buttons"}
          aria-label={navHidden ? "Show nav buttons" : "Hide nav buttons"}
          aria-expanded={!navHidden}
          aria-controls="workspace-nav"
          onClick={onToggleNav}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ display: "block" }}
            aria-hidden="true"
          >
            <polyline points={navHidden ? "6 9 12 15 18 9" : "6 15 12 9 18 15"} />
          </svg>
        </button>
      </div>

      {!navHidden && (
        <div id="workspace-nav" className="chat-head-nav" data-tauri-drag-region>
          {children}
        </div>
      )}
    </div>
  );
}
