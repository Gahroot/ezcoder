import { projectId, projectKey } from "../ids.js";
import type { Db, ProjectRow } from "../types.js";

export async function createProject(db: Db, name: string): Promise<ProjectRow> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("name is required");
  const row: ProjectRow = {
    id: projectId(),
    name: trimmed,
    key: projectKey(),
    created_at: Date.now(),
  };
  await db.run("INSERT INTO projects (id, name, key, created_at) VALUES (?, ?, ?, ?)", [
    row.id,
    row.name,
    row.key,
    row.created_at,
  ]);
  return row;
}

export async function findProjectByKey(db: Db, key: string): Promise<ProjectRow | null> {
  return db.one<ProjectRow>("SELECT * FROM projects WHERE key = ?", [key]);
}

export async function findProjectById(db: Db, id: string): Promise<ProjectRow | null> {
  return db.one<ProjectRow>("SELECT * FROM projects WHERE id = ?", [id]);
}
