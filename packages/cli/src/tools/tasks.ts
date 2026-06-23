import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { AgentTool } from "@prestyj/agent";
import { log } from "../core/logger.js";
import { loadTasks, saveTasks, type TaskListItem, type TaskStatus } from "../core/task-store.js";

const TasksParams = z.object({
  action: z
    .enum(["add", "list", "update", "done", "remove"])
    .describe(
      "Action: add a task, list tasks, update a task's status/title/prompt, mark done, or remove",
    ),
  title: z
    .string()
    .optional()
    .describe("Short task title for display (max ~10 words, required for add)"),
  prompt: z
    .string()
    .optional()
    .describe(
      "The standalone prompt sent to an agent with no context (required for add). " +
        "Concise, actionable instruction with file paths and what to change.",
    ),
  status: z
    .enum(["pending", "in-progress", "done"])
    .optional()
    .describe("New status for the update action (pending, in-progress, or done)."),
  id: z
    .string()
    .optional()
    .describe("Task ID (required for update/done/remove — use list to find IDs)"),
});

export function createTasksTool(cwd: string): AgentTool<typeof TasksParams> {
  let pending: Promise<void> = Promise.resolve();

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = pending.then(fn);
    pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  return {
    name: "tasks",
    description:
      "Manage the project task list. Each task has a short title (shown in " +
      "the task pane) and a prompt (sent as a standalone instruction to an " +
      "agent with no context). Write prompts as concise, actionable directives " +
      "with specific file paths — the agent must complete it from the prompt alone. " +
      "When adding multiple tasks, order them by dependency — foundational work " +
      "first, then core logic, integration, UI, and tests. " +
      "Use the update action to change a task's status (pending/in-progress/done) or " +
      "edit its title/prompt without recreating it. " +
      "Do not use this tool proactively — only manage the task list when the user explicitly requests it.",
    parameters: TasksParams,
    executionMode: "sequential",
    execute({ action, title, prompt, status, id }) {
      return enqueue(async () => {
        switch (action) {
          case "add": {
            if (!title?.trim()) return "Error: title is required for add action.";
            if (!prompt?.trim()) return "Error: prompt is required for add action.";
            const tasks = await loadTasks(cwd);
            const newTask: TaskListItem = {
              id: randomUUID(),
              title: title.trim(),
              prompt: prompt.trim(),
              status: "pending",
              createdAt: new Date().toISOString(),
            };
            await saveTasks(cwd, [...tasks, newTask]);
            log("INFO", "tasks", `Task added: ${newTask.title}`, { id: newTask.id });
            return `Task added: "${newTask.title}" (id: ${newTask.id.slice(0, 8)})`;
          }

          case "list": {
            const tasks = await loadTasks(cwd);
            if (tasks.length === 0) return "No tasks.";
            const lines = tasks.map((task) => {
              const check =
                task.status === "done" ? "✓" : task.status === "in-progress" ? "~" : " ";
              return `[${check}] ${task.title}  (id: ${task.id.slice(0, 8)}, ${task.status})`;
            });
            log("INFO", "tasks", `Listed ${tasks.length} tasks`);
            return lines.join("\n");
          }

          case "update": {
            if (!id?.trim()) return "Error: id is required for update action.";
            if (!status && !title?.trim() && !prompt?.trim())
              return "Error: update needs at least one of status, title, or prompt.";
            const tasks = await loadTasks(cwd);
            const task = tasks.find((item) => item.id === id || item.id.startsWith(id));
            if (!task) return `Error: no task found matching id "${id}".`;
            const updated = tasks.map((item) =>
              item.id === task.id
                ? {
                    ...item,
                    ...(status ? { status: status as TaskStatus } : {}),
                    ...(title?.trim() ? { title: title.trim() } : {}),
                    ...(prompt?.trim() ? { prompt: prompt.trim() } : {}),
                  }
                : item,
            );
            await saveTasks(cwd, updated);
            log("INFO", "tasks", `Task updated: ${task.title}`, { id: task.id });
            const changes = [
              status ? `status=${status}` : null,
              title?.trim() ? "title" : null,
              prompt?.trim() ? "prompt" : null,
            ]
              .filter(Boolean)
              .join(", ");
            return `Updated "${title?.trim() ?? task.title}" (${changes}).`;
          }

          case "done": {
            if (!id?.trim()) return "Error: id is required for done action.";
            const tasks = await loadTasks(cwd);
            const task = tasks.find((item) => item.id === id || item.id.startsWith(id));
            if (!task) return `Error: no task found matching id "${id}".`;
            const updated = tasks.map((item) =>
              item.id === task.id ? { ...item, status: "done" as const } : item,
            );
            await saveTasks(cwd, updated);
            log("INFO", "tasks", `Task done: ${task.title}`, { id: task.id });
            return `Marked done: "${task.title}"`;
          }

          case "remove": {
            if (!id?.trim()) return "Error: id is required for remove action.";
            const tasks = await loadTasks(cwd);
            const removed = tasks.find((item) => item.id === id || item.id.startsWith(id));
            if (!removed) return `Error: no task found matching id "${id}".`;
            await saveTasks(
              cwd,
              tasks.filter((item) => item.id !== removed.id),
            );
            log("INFO", "tasks", `Task removed: ${removed.title}`, { id: removed.id });
            return `Removed: "${removed.title}"`;
          }
        }
      });
    },
  };
}
