import { useCallback, useEffect, useState } from "react";
import { theme } from "./theme";
import { listWorktrees, removeWorktree, type WorktreeStatus } from "./agent";

interface Props {
  /** The project whose copies are listed. */
  cwd: string;
  /** Directories other windows hold; those copies are never offered. */
  busyPaths?: string[];
}

/** Last path segment, for a human-readable copy name. */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * What this copy holds, in the user's words rather than git's. Unsaved work is
 * named before unmerged commits because it is the one that cannot be recovered
 * from anywhere else.
 */
function describeWork(w: WorktreeStatus): string | null {
  const parts: string[] = [];
  if (w.dirtyFiles > 0) parts.push(`${w.dirtyFiles} unsaved file${w.dirtyFiles === 1 ? "" : "s"}`);
  // A copy made outside ezcoder keeps its branch when removed, so its
  // commits are not lost and are not worth warning about.
  if (w.commitsAhead > 0 && w.managed) {
    parts.push(`${w.commitsAhead} unmerged change${w.commitsAhead === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function describe(w: WorktreeStatus): string {
  const parts: string[] = [];
  const work = describeWork(w);
  if (work) parts.push(work);
  if (w.missing) parts.push("folder already deleted");
  if (w.busy) parts.push("open in another window");
  if (!w.managed) parts.push("made outside ezcoder");
  return parts.length > 0 ? parts.join(" · ") : "nothing to lose";
}

/** What the confirm button says will happen. */
function confirmLabel(w: WorktreeStatus): string {
  const work = describeWork(w);
  if (work) return `Delete ${work}`;
  return w.managed ? "Delete it" : "Delete this folder";
}

/**
 * The copies of a project that currently exist on disk.
 *
 * Copies holding no work are reclaimed automatically when their window closes,
 * so anything listed here is either in use or holds something. That is the
 * point of showing it: a list that is usually empty, and when it is not, says
 * exactly what is keeping each copy alive.
 *
 * Cleanup of a copy holding work is deliberately two steps — the first click
 * replaces the button with a confirm naming what is lost. Nothing here deletes
 * unsaved work on a single click.
 */
export function WorktreeList({ cwd, busyPaths = [] }: Props): React.ReactElement | null {
  const [worktrees, setWorktrees] = useState<WorktreeStatus[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The caller passes a fresh array each render, so the CONTENTS are the real
  // dependency — keying on the array identity would refetch on every render.
  const busyKey = busyPaths.join("\u0000");
  const refresh = useCallback(() => {
    void listWorktrees(cwd, busyKey ? busyKey.split("\u0000") : []).then(setWorktrees);
  }, [cwd, busyKey]);

  useEffect(refresh, [refresh]);

  async function clean(w: WorktreeStatus, force: boolean): Promise<void> {
    if (busyPath) return;
    setBusyPath(w.path);
    setError(null);
    try {
      await removeWorktree(cwd, w.path, force);
      setConfirming(null);
      refresh();
    } catch (e) {
      // The daemon's refusal explains what would be lost; show it verbatim.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyPath(null);
    }
  }

  if (worktrees.length === 0) return null;

  return (
    <div className="worktree-list">
      <div className="worktree-list-title" style={{ color: theme.textSecondary }}>
        Separate copies of this project ({worktrees.length})
      </div>
      {worktrees.map((w) => {
        const isConfirming = confirming === w.path;
        const working = busyPath === w.path;
        return (
          <div key={w.path} className="worktree-row">
            <div className="worktree-row-main">
              <span className="worktree-branch" style={{ color: theme.text }}>
                {w.branch ?? baseName(w.path)}
              </span>
              <span className="worktree-detail" style={{ color: theme.textSecondary }}>
                {describe(w)}
              </span>
              {!w.managed && (
                // Copies made elsewhere can live anywhere; say where, so the
                // user knows which folder the button is about to remove.
                <span
                  className="worktree-path"
                  style={{ color: theme.textSecondary }}
                  title={w.path}
                >
                  <bdi>{w.path}</bdi>
                </span>
              )}
            </div>
            {isConfirming ? (
              <div className="worktree-row-actions">
                <button
                  className="modal-btn"
                  disabled={working}
                  onClick={() => setConfirming(null)}
                >
                  Keep it
                </button>
                <button
                  className="modal-btn danger"
                  disabled={working}
                  onClick={() => void clean(w, true)}
                >
                  {working ? "Deleting\u2026" : confirmLabel(w)}
                </button>
              </div>
            ) : (
              <button
                className="modal-btn"
                // A copy someone is working in is never removable from here:
                // forcing it would pull the folder out from under a live agent.
                disabled={working || w.busy}
                onClick={() => {
                  if (w.reclaimable) void clean(w, false);
                  else setConfirming(w.path);
                }}
              >
                {working ? "Cleaning\u2026" : "Clean up"}
              </button>
            )}
          </div>
        );
      })}
      {error && (
        <div className="modal-error" style={{ color: theme.error }}>
          {error}
        </div>
      )}
    </div>
  );
}
