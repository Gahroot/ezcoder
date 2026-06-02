import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type TaskStatus = "pending" | "in-progress" | "done";

export interface TaskListItem {
  id: string;
  title: string;
  prompt: string;
  /** @deprecated Old field — migrated to title+prompt on load. */
  text?: string;
  details?: string;
  status: TaskStatus;
  createdAt: string;
}

export interface PendingTaskInfo {
  id: string;
  title: string;
  prompt: string;
}

const DEFAULT_TASKS_BASE = join(homedir(), ".ezcoder", "tasks", "projects");
const LEGACY_TASKS_BASE = join(homedir(), ".ezcoder-tasks", "projects");

function tasksBase(): string {
  return process.env.EZCODER_TASKS_BASE ?? DEFAULT_TASKS_BASE;
}

function legacyTasksBase(): string | null {
  if (process.env.EZCODER_TASKS_BASE) return null;
  return process.env.GG_TASKS_BASE ?? LEGACY_TASKS_BASE;
}

export function taskProjectHash(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

export function taskProjectDir(cwd: string, base = tasksBase()): string {
  return join(base, taskProjectHash(cwd));
}

function tasksFilePath(cwd: string, base = tasksBase()): string {
  return join(taskProjectDir(cwd, base), "tasks.json");
}

function metaFilePath(cwd: string, base = tasksBase()): string {
  return join(taskProjectDir(cwd, base), "meta.json");
}

function normalizeTask(raw: Partial<TaskListItem>): TaskListItem | null {
  if (!raw.id || typeof raw.id !== "string") return null;
  const fallbackText = typeof raw.text === "string" ? raw.text : "Untitled task";
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title : fallbackText;
  const prompt = typeof raw.prompt === "string" && raw.prompt.trim() ? raw.prompt : title;
  const status: TaskStatus =
    raw.status === "done" || raw.status === "in-progress" || raw.status === "pending"
      ? raw.status
      : "pending";
  const createdAt =
    typeof raw.createdAt === "string" && raw.createdAt.trim()
      ? raw.createdAt
      : new Date(0).toISOString();

  return {
    id: raw.id,
    title,
    prompt,
    ...(raw.text ? { text: raw.text } : {}),
    ...(raw.details ? { details: raw.details } : {}),
    status,
    createdAt,
  };
}

function parseTasks(data: string): TaskListItem[] {
  const raw = JSON.parse(data) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => normalizeTask(item as Partial<TaskListItem>))
    .filter((item): item is TaskListItem => item !== null);
}

async function readTasksFromBase(cwd: string, base: string): Promise<TaskListItem[] | null> {
  try {
    return parseTasks(await readFile(tasksFilePath(cwd, base), "utf-8"));
  } catch {
    return null;
  }
}

function readTasksFromBaseSync(cwd: string, base: string): TaskListItem[] | null {
  try {
    return parseTasks(readFileSync(tasksFilePath(cwd, base), "utf-8"));
  } catch {
    return null;
  }
}

async function writeTasksToBase(
  cwd: string,
  tasks: readonly TaskListItem[],
  base: string,
): Promise<void> {
  const dir = taskProjectDir(cwd, base);
  await mkdir(dir, { recursive: true });
  await writeFile(tasksFilePath(cwd, base), JSON.stringify(tasks, null, 2) + "\n", "utf-8");
  await writeFile(
    metaFilePath(cwd, base),
    JSON.stringify({ path: cwd, name: basename(cwd) }, null, 2) + "\n",
    "utf-8",
  );
}

function writeTasksToBaseSync(cwd: string, tasks: readonly TaskListItem[], base: string): void {
  const dir = taskProjectDir(cwd, base);
  mkdirSync(dir, { recursive: true });
  writeFileSync(tasksFilePath(cwd, base), JSON.stringify(tasks, null, 2) + "\n", "utf-8");
  writeFileSync(
    metaFilePath(cwd, base),
    JSON.stringify({ path: cwd, name: basename(cwd) }, null, 2) + "\n",
    "utf-8",
  );
}

async function migrateLegacyTasksIfNeeded(cwd: string): Promise<TaskListItem[] | null> {
  const legacyBase = legacyTasksBase();
  if (!legacyBase) return null;
  const targetFile = tasksFilePath(cwd);
  if (existsSync(targetFile)) return null;
  const legacyTasks = await readTasksFromBase(cwd, legacyBase);
  if (!legacyTasks) return null;
  await writeTasksToBase(cwd, legacyTasks, tasksBase());
  return legacyTasks;
}

function migrateLegacyTasksIfNeededSync(cwd: string): TaskListItem[] | null {
  const legacyBase = legacyTasksBase();
  if (!legacyBase) return null;
  const targetFile = tasksFilePath(cwd);
  if (existsSync(targetFile)) return null;
  const legacyTasks = readTasksFromBaseSync(cwd, legacyBase);
  if (!legacyTasks) return null;
  writeTasksToBaseSync(cwd, legacyTasks, tasksBase());
  return legacyTasks;
}

export async function loadTasks(cwd: string): Promise<TaskListItem[]> {
  const tasks = await readTasksFromBase(cwd, tasksBase());
  if (tasks) return tasks;
  return (await migrateLegacyTasksIfNeeded(cwd)) ?? [];
}

export function loadTasksSync(cwd: string): TaskListItem[] {
  return readTasksFromBaseSync(cwd, tasksBase()) ?? migrateLegacyTasksIfNeededSync(cwd) ?? [];
}

export async function saveTasks(cwd: string, tasks: readonly TaskListItem[]): Promise<void> {
  await writeTasksToBase(cwd, tasks, tasksBase());
}

export function saveTasksSync(cwd: string, tasks: readonly TaskListItem[]): void {
  writeTasksToBaseSync(cwd, tasks, tasksBase());
}

export function getTaskCount(cwd: string): number {
  return loadTasksSync(cwd).filter((task) => task.status !== "done").length;
}

export function getNextPendingTask(cwd: string): PendingTaskInfo | null {
  const pending = loadTasksSync(cwd).find((task) => task.status === "pending");
  if (!pending) return null;
  return {
    id: pending.id,
    title: pending.title,
    prompt: pending.prompt,
  };
}

export function markTaskInProgress(cwd: string, taskId: string): void {
  const tasks = loadTasksSync(cwd);
  if (tasks.length === 0) return;
  const updated = tasks.map((task) =>
    task.id === taskId ? { ...task, status: "in-progress" as const } : task,
  );
  saveTasksSync(cwd, updated);
}
