import { useState } from "react";
import { theme } from "./theme";
import { Modal } from "./Modal";
import type { ProjectTask } from "./agent";

/**
 * Task list modal. Mirrors the CLI's task pane: shows every project task with
 * its status, lets the user add tasks, edit a task's title/prompt, cycle its
 * status, run one task (fresh session, end-to-end) or run all pending tasks
 * sequentially, and delete tasks. The agent loop streams progress back into the
 * transcript — this modal just kicks things off and reflects the live status
 * updates pushed via the `tasks_list` SSE event.
 */
interface Props {
  tasks: readonly ProjectTask[];
  /** True while the agent is running (task or chat) — disables run actions. */
  running: boolean;
  /** True while the list is being (re)fetched from the sidecar. */
  loading?: boolean;
  /** True when the last fetch failed (sidecar not ready / errored). */
  error?: boolean;
  /** Retry a failed/empty load. */
  onRetry?: () => void;
  onAdd: (title: string, prompt: string) => void;
  onUpdate: (
    id: string,
    patch: { status?: ProjectTask["status"]; title?: string; prompt?: string },
  ) => void;
  onRun: (id: string) => void;
  onRunAll: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

const STATUS_STYLE: Record<ProjectTask["status"], { label: string; color: string; glyph: string }> =
  {
    pending: { label: "pending", color: theme.textMuted, glyph: "\u25CB" },
    "in-progress": { label: "running", color: theme.warning, glyph: "\u23FA" },
    done: { label: "done", color: theme.success, glyph: "\u2713" },
  };

// Clicking a task's status cycles it through this order.
const STATUS_CYCLE: ProjectTask["status"][] = ["pending", "in-progress", "done"];

function nextStatus(status: ProjectTask["status"]): ProjectTask["status"] {
  const i = STATUS_CYCLE.indexOf(status);
  return STATUS_CYCLE[(i + 1) % STATUS_CYCLE.length];
}

export function TasksModal({
  tasks,
  running,
  loading = false,
  error = false,
  onRetry,
  onAdd,
  onUpdate,
  onRun,
  onRunAll,
  onDelete,
  onClose,
}: Props): React.ReactElement {
  const pending = tasks.filter((t) => t.status !== "done");
  const hasPending = pending.length > 0;
  const isEmpty = tasks.length === 0;

  const [adding, setAdding] = useState(false);
  const [addTitle, setAddTitle] = useState("");
  const [addPrompt, setAddPrompt] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editPrompt, setEditPrompt] = useState("");

  function submitAdd(): void {
    const title = addTitle.trim();
    if (!title) return;
    onAdd(title, addPrompt.trim() || title);
    setAddTitle("");
    setAddPrompt("");
    setAdding(false);
  }

  function startEdit(task: ProjectTask): void {
    setEditingId(task.id);
    setEditTitle(task.title);
    setEditPrompt(task.prompt);
  }

  function submitEdit(): void {
    if (!editingId) return;
    const title = editTitle.trim();
    onUpdate(editingId, {
      ...(title ? { title } : {}),
      prompt: editPrompt.trim() || title || editPrompt,
    });
    setEditingId(null);
  }

  return (
    <Modal title="Tasks" onClose={onClose}>
      {isEmpty && loading ? (
        <div className="tasks-empty" style={{ color: theme.textMuted }}>
          Loading tasks…
        </div>
      ) : isEmpty && error ? (
        <div className="tasks-empty" style={{ color: theme.textMuted }}>
          Couldn’t load tasks (the agent may still be starting).
          {onRetry && (
            <>
              {" "}
              <button className="btn btn-sm btn-ghost" onClick={onRetry}>
                Retry
              </button>
            </>
          )}
        </div>
      ) : (
        <>
          {isEmpty ? (
            <div className="tasks-empty" style={{ color: theme.textMuted }}>
              No tasks yet. Add one below, then run them here.
            </div>
          ) : (
            <div className="tasks-list">
              {tasks.map((task) => {
                const status = STATUS_STYLE[task.status];
                const isDone = task.status === "done";
                if (editingId === task.id) {
                  return (
                    <div className="tasks-edit" key={task.id}>
                      <input
                        className="tasks-input"
                        value={editTitle}
                        placeholder="Task title"
                        autoFocus
                        onChange={(e) => setEditTitle(e.target.value)}
                      />
                      <textarea
                        className="tasks-textarea"
                        value={editPrompt}
                        placeholder="Prompt sent to the agent (defaults to the title)"
                        rows={3}
                        onChange={(e) => setEditPrompt(e.target.value)}
                      />
                      <div className="tasks-edit-actions">
                        <button className="btn btn-sm btn-primary" onClick={submitEdit}>
                          Save
                        </button>
                        <button className="btn btn-sm btn-ghost" onClick={() => setEditingId(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  );
                }
                return (
                  <div className="tasks-item" key={task.id}>
                    <button
                      className="tasks-dot"
                      style={{ color: status.color, cursor: "pointer" }}
                      title={`Status: ${status.label} — click to cycle`}
                      onClick={() => onUpdate(task.id, { status: nextStatus(task.status) })}
                    >
                      {status.glyph}
                    </button>
                    <span
                      className="tasks-title"
                      style={{ color: isDone ? theme.textMuted : theme.text }}
                      title={task.prompt}
                    >
                      {task.title}
                    </span>
                    <span className="tasks-status" style={{ color: status.color }}>
                      {status.label}
                    </span>
                    <button
                      className="btn btn-sm btn-ghost tasks-edit-one"
                      title="Edit title / prompt"
                      onClick={() => startEdit(task)}
                    >
                      Edit
                    </button>
                    {!isDone && (
                      <button
                        className="btn btn-sm btn-ghost tasks-run-one"
                        disabled={running}
                        title="Run this task in a fresh session"
                        onClick={() => onRun(task.id)}
                      >
                        Run
                      </button>
                    )}
                    <button
                      className="tasks-delete"
                      style={{ color: theme.textDim }}
                      title="Delete task"
                      onClick={() => onDelete(task.id)}
                    >
                      {"\u00d7"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {adding ? (
            <div className="tasks-edit tasks-add">
              <input
                className="tasks-input"
                value={addTitle}
                placeholder="Task title"
                autoFocus
                onChange={(e) => setAddTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitAdd();
                }}
              />
              <textarea
                className="tasks-textarea"
                value={addPrompt}
                placeholder="Prompt sent to the agent (defaults to the title)"
                rows={3}
                onChange={(e) => setAddPrompt(e.target.value)}
              />
              <div className="tasks-edit-actions">
                <button
                  className="btn btn-sm btn-primary"
                  disabled={!addTitle.trim()}
                  onClick={submitAdd}
                >
                  Add task
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => setAdding(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="tasks-actions">
              <button className="btn btn-sm btn-ghost" onClick={() => setAdding(true)}>
                + Add task
              </button>
              <button
                className="btn btn-sm btn-primary"
                disabled={running || !hasPending}
                title={
                  hasPending
                    ? "Run all pending tasks, one fresh session each"
                    : "No pending tasks to run"
                }
                onClick={onRunAll}
              >
                {`Run all (${pending.length})`}
              </button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
