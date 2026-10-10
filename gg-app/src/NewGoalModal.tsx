import { useEffect, useId, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileTextIcon, FolderSimpleIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { ModalDismissButton } from "./modal-embed";
import { createGoal, selectProject, type GoalSummary } from "./agent";

/** Mirrors the sidecar's limits in ggcoder `core/goals-store.ts`. */
const NAME_MAX = 15;
const GOAL_MAX = 2000;
const CONTEXT_MAX = 20;

interface ContextPick {
  path: string;
  kind: "folder" | "file";
}

interface Props {
  onClose: () => void;
  /** Called after the goal exists and this window is pointed at it. */
  onCreated: (goal: GoalSummary) => void;
}

/** Last path segment, for a compact row label (the full path is the tooltip). */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * Create a Goal: a name, the objective in a sentence or two, and optional
 * folders/files for context. Creating it opens the goal, where the coordinator
 * replies on its own.
 */
export function NewGoalModal({ onClose, onCreated }: Props): React.ReactElement {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [context, setContext] = useState<ContextPick[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const nameCountId = useId();
  const goalId = useId();
  const contextId = useId();
  const menuId = useId();
  const addRef = useRef<HTMLDivElement>(null);
  const addTriggerRef = useRef<HTMLButtonElement>(null);

  const canCreate = name.trim().length > 0 && goal.trim().length > 0 && !busy;

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutside = (event: MouseEvent): void => {
      if (addRef.current && !addRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    // Escape closes only the menu, not the whole modal underneath it.
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setMenuOpen(false);
      addTriggerRef.current?.focus();
    };
    const id = window.setTimeout(() => document.addEventListener("mousedown", closeOnOutside), 0);
    document.addEventListener("keydown", closeOnEscape, true);
    requestAnimationFrame(() =>
      addRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus(),
    );
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [menuOpen]);

  function moveMenuFocus(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[role='menuitem']"),
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  async function addContext(kind: "folder" | "file"): Promise<void> {
    setMenuOpen(false);
    try {
      const picked = await openDialog({
        directory: kind === "folder",
        multiple: true,
        title: kind === "folder" ? "Add folders to this goal" : "Add files to this goal",
      });
      const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
      if (paths.length > 0) {
        setContext((prev) => {
          const seen = new Set(prev.map((c) => c.path));
          const added = paths
            .filter((p) => !seen.has(p))
            .map((p): ContextPick => ({ path: p, kind }));
          return [...prev, ...added].slice(0, CONTEXT_MAX);
        });
      }
    } catch (e) {
      setError(`Couldn't open the picker: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      requestAnimationFrame(() => addTriggerRef.current?.focus());
    }
  }

  async function create(): Promise<void> {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createGoal({
        name: name.trim(),
        goal: goal.trim(),
        context: context.map((c) => c.path),
      });
      // A goal opens as its own coordinator session in a fresh conversation.
      await selectProject(created.path);
      onCreated(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal title="New goal" onClose={onClose} className="goal-modal">
      <div className="goal-name-head">
        <label className="modal-label" htmlFor={nameId}>
          Name
        </label>
        <span id={nameCountId} className="goal-name-count" style={{ color: theme.textDim }}>
          {`${name.length}/${NAME_MAX}`}
        </span>
      </div>
      <input
        id={nameId}
        className="modal-input"
        style={{ color: theme.text, background: theme.inputBackground }}
        value={name}
        maxLength={NAME_MAX}
        aria-describedby={nameCountId}
        placeholder="API latency"
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void create();
        }}
      />

      <label className="modal-label" htmlFor={goalId}>
        Goal
      </label>
      <textarea
        id={goalId}
        className="modal-input goal-textarea"
        style={{ color: theme.text, background: theme.inputBackground }}
        value={goal}
        maxLength={GOAL_MAX}
        rows={3}
        placeholder="Bring p95 latency under 200 ms across the whole API"
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void create();
        }}
      />

      <div className="goal-context-head">
        <span className="modal-label goal-context-label" id={contextId}>
          Context{" "}
          <span className="goal-optional" style={{ color: theme.textDim }}>
            (optional)
          </span>
        </span>
        <div className="goal-add" ref={addRef}>
          <button
            ref={addTriggerRef}
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy || context.length >= CONTEXT_MAX}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <PlusIcon size={14} weight="bold" aria-hidden="true" />
            Add
          </button>
          {menuOpen && (
            <div
              id={menuId}
              className="winlayout-menu"
              role="menu"
              aria-label="Add context"
              onKeyDown={moveMenuFocus}
              style={{ background: theme.surface2, borderColor: theme.border }}
            >
              <button
                type="button"
                role="menuitem"
                className="winlayout-item"
                onClick={() => void addContext("folder")}
              >
                <FolderSimpleIcon size={16} aria-hidden="true" />
                Add folders
              </button>
              <button
                type="button"
                role="menuitem"
                className="winlayout-item"
                onClick={() => void addContext("file")}
              >
                <FileTextIcon size={16} aria-hidden="true" />
                Add files
              </button>
            </div>
          )}
        </div>
      </div>
      {context.length > 0 ? (
        <ul className="goal-context-list" aria-labelledby={contextId}>
          {context.map((item) => (
            <li key={item.path} className="goal-context-item" title={item.path}>
              {item.kind === "folder" ? (
                <FolderSimpleIcon size={16} aria-hidden="true" style={{ color: theme.textMuted }} />
              ) : (
                <FileTextIcon size={16} aria-hidden="true" style={{ color: theme.textMuted }} />
              )}
              <span className="goal-context-name" style={{ color: theme.text }}>
                {baseName(item.path)}
              </span>
              <button
                type="button"
                className="picker-hide goal-context-remove"
                aria-label={`Remove ${baseName(item.path)}`}
                title="Remove"
                disabled={busy}
                onClick={() => setContext((prev) => prev.filter((c) => c.path !== item.path))}
              >
                <XIcon size={12} weight="bold" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="modal-hint" style={{ color: theme.textDim }}>
          Folders and files the goal is about, like repos, specs or mock-ups.
        </div>
      )}

      {error && (
        <div className="modal-error" role="alert" style={{ color: theme.error }}>
          {error}
        </div>
      )}
      <div className="modal-actions">
        <ModalDismissButton onClick={onClose}>Cancel</ModalDismissButton>
        <button className="modal-btn primary" disabled={!canCreate} onClick={() => void create()}>
          {busy ? "Creating\u2026" : "Create goal"}
        </button>
      </div>
    </Modal>
  );
}
