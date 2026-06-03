import { useCallback, useState } from "react";
import {
  getNextPendingTask,
  loadTasksSync,
  markTaskInProgress,
  saveTasksSync,
  type TaskListItem,
} from "../../core/task-store.js";

interface UseTaskPickerControllerOptions {
  displayedCwd: string;
  onStartTask: (title: string, prompt: string, taskId: string) => void;
  onRunAllTasksChange: (runAll: boolean) => void;
}

interface TaskPickerController {
  open: boolean;
  tasks: TaskListItem[];
  close: () => void;
  openPicker: () => void;
  toggle: () => void;
  start: (task: TaskListItem) => void;
  runAll: (task?: TaskListItem) => void;
  deleteTask: (task: TaskListItem) => void;
}

export function useTaskPickerController({
  displayedCwd,
  onStartTask,
  onRunAllTasksChange,
}: UseTaskPickerControllerOptions): TaskPickerController {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<TaskListItem[]>(() => loadTasksSync(displayedCwd));

  const refresh = useCallback(() => setTasks(loadTasksSync(displayedCwd)), [displayedCwd]);
  const close = useCallback(() => setOpen(false), []);

  const openPicker = useCallback(() => {
    setTasks(loadTasksSync(displayedCwd));
    setOpen(true);
  }, [displayedCwd]);

  const toggle = useCallback(() => {
    setTasks(loadTasksSync(displayedCwd));
    setOpen((current) => !current);
  }, [displayedCwd]);

  const start = useCallback(
    (task: TaskListItem) => {
      setOpen(false);
      markTaskInProgress(displayedCwd, task.id);
      refresh();
      onStartTask(task.title, task.prompt, task.id);
    },
    [displayedCwd, onStartTask, refresh],
  );

  const runAll = useCallback(
    (task?: TaskListItem) => {
      setOpen(false);
      onRunAllTasksChange(true);
      const selected = task
        ? { id: task.id, title: task.title, prompt: task.prompt || task.text || task.title }
        : getNextPendingTask(displayedCwd);
      if (!selected) return;
      markTaskInProgress(displayedCwd, selected.id);
      refresh();
      onStartTask(selected.title, selected.prompt, selected.id);
    },
    [displayedCwd, onRunAllTasksChange, onStartTask, refresh],
  );

  const deleteTask = useCallback(
    (task: TaskListItem) => {
      const nextTasks = loadTasksSync(displayedCwd).filter((candidate) => candidate.id !== task.id);
      saveTasksSync(displayedCwd, nextTasks);
      setTasks(nextTasks);
    },
    [displayedCwd],
  );

  return { open, tasks, close, openPicker, toggle, start, runAll, deleteTask };
}
