import { useState } from "react";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { createWorktree } from "./agent";

interface Props {
  /** The project the user asked to open. */
  cwd: string;
  /** Other windows already bound to `cwd` — never empty when this is shown. */
  windows: { label: string; title: string }[];
  onClose: () => void;
  /**
   * Proceed with the open. `cwd` is the isolated worktree path when the user
   * chose to isolate, or the original project path when they chose to share.
   */
  onResolved: (cwd: string) => void;
}

/** Last path segment, for a human-readable project name. */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * Shown when a project is already open in another window. Two agents editing one
 * working tree overwrite each other, so the default is an isolated git worktree:
 * a separate folder on its own branch, which the second agent gets automatically
 * without the user having to think about worktrees at all.
 *
 * Sharing stays available (and is the right answer when the second window is
 * only there to read), which is why this asks rather than isolating silently.
 *
 * Unsaved work in the other window no longer blocks this: the copy starts from
 * the last commit, which is what keeps two agents from inheriting each other's
 * half-written edits.
 */
export function WorktreePrompt({ cwd, windows, onClose, onResolved }: Props): React.ReactElement {
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A copy that exists but whose dependency install failed; path + reason. */
  const [halfReady, setHalfReady] = useState<{ path: string; reason: string } | null>(null);

  const name = baseName(cwd);
  const others = windows.map((w) => w.title).join(", ");

  async function isolate(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setHalfReady(null);
    try {
      const created = await createWorktree(cwd, branch.trim() || undefined);
      // The copy is ready but its install failed. Opening anyway is still the
      // user's call — an agent let loose in a copy that cannot build wastes a
      // whole session failing at the first command — so this stops and says so
      // rather than proceeding into a broken tree.
      const failed = created.setup?.installs?.find((r) => !r.ok);
      if (failed) {
        setHalfReady({
          path: created.path,
          reason: `${failed.command} failed: ${failed.message ?? "no detail"}`,
        });
        setBusy(false);
        return;
      }
      onResolved(created.path);
    } catch (e) {
      // The daemon's 409 (not a repo) is the user's to fix, so the message is
      // shown as written rather than reduced to a generic.
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal title={`${name} is already open`} onClose={onClose}>
      <div className="modal-hint" style={{ color: theme.textSecondary }}>
        Another window ({others}) is working in this project. Two agents in the same folder can
        overwrite each other&rsquo;s edits. Give this window its own copy on a new branch?
      </div>
      <div className="modal-hint" style={{ color: theme.textMuted }}>
        The copy lives outside your project folder and is cleaned up on its own when you close it,
        unless it still holds unsaved or unmerged work. It starts from your last commit, with your
        local config and packages set up for you.
      </div>
      <input
        className="modal-input"
        style={{ color: theme.text, background: theme.inputBackground }}
        value={branch}
        placeholder="branch name (optional)"
        autoFocus
        disabled={busy}
        onChange={(e) => setBranch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void isolate();
        }}
      />
      {busy && (
        <div className="modal-hint" style={{ color: theme.textMuted }}>
          Making your copy, then installing its packages. On a big project this can take a minute.
        </div>
      )}
      {halfReady && (
        <div className="modal-error" style={{ color: theme.error }}>
          Your copy is ready, but setting up its packages didn&rsquo;t finish — {halfReady.reason}.
          Open it and run the install yourself, or work in the shared folder instead.
        </div>
      )}
      {error && (
        <div className="modal-error" style={{ color: theme.error }}>
          {error}
        </div>
      )}
      <div className="modal-actions">
        <button className="modal-btn" disabled={busy} onClick={() => onResolved(cwd)}>
          Open anyway
        </button>
        {halfReady ? (
          <button className="modal-btn primary" onClick={() => onResolved(halfReady.path)}>
            Open the copy
          </button>
        ) : (
          <button className="modal-btn primary" disabled={busy} onClick={() => void isolate()}>
            {busy ? "Setting up\u2026" : "Own copy"}
          </button>
        )}
      </div>
    </Modal>
  );
}
