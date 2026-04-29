import { Hono } from "hono";
import { cors } from "hono/cors";
import { d1Db } from "./db.js";
import { ingestEvent } from "./handlers/ingest.js";
import { createProject } from "./handlers/projects.js";
import { deleteError, getError, listErrors, patchError } from "./handlers/errors.js";
import type { AppEnv, PatchErrorBody, WireEvent } from "./types.js";

const app = new Hono<AppEnv>();

// Browser SDKs POST from arbitrary origins. The project_key in the body /
// header is the auth boundary, not Origin — so any-origin CORS is safe here.
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["content-type", "x-pixel-key"],
    maxAge: 86400,
  }),
);

app.post("/ingest", async (c) => {
  const headerKey = c.req.header("x-pixel-key");
  let body: WireEvent;
  try {
    body = await c.req.json<WireEvent>();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid body" }, 400);
  }
  if (headerKey && headerKey !== body.project_key) {
    return c.json({ error: "project_key mismatch" }, 400);
  }
  const result = await ingestEvent(d1Db(c.env.DB), body);
  if (result.kind === "unknown_project") {
    return c.json({ error: "unknown project_key" }, 401);
  }
  if (result.kind === "duplicate") {
    return c.json({ error_id: result.error.id, duplicate: true });
  }
  return c.json({
    error_id: result.error.id,
    created: result.created,
    recurred: result.recurred,
  });
});

app.post("/api/projects", async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  if (!body.name) return c.json({ error: "name is required" }, 400);
  const project = await createProject(d1Db(c.env.DB), body.name);
  return c.json(project, 201);
});

app.get("/api/projects/:id/errors", async (c) => {
  const projectId = c.req.param("id");
  const status = c.req.query("status");
  try {
    const rows = await listErrors(d1Db(c.env.DB), projectId, status);
    return c.json({ errors: rows });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.get("/api/errors/:id", async (c) => {
  const row = await getError(d1Db(c.env.DB), c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

app.patch("/api/errors/:id", async (c) => {
  const body = await c.req.json<PatchErrorBody>().catch(() => ({}));
  try {
    const row = await patchError(d1Db(c.env.DB), c.req.param("id"), body);
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.delete("/api/errors/:id", async (c) => {
  const ok = await deleteError(d1Db(c.env.DB), c.req.param("id"));
  if (!ok) return c.json({ error: "not found" }, 404);
  return c.json({ deleted: true });
});

app.get("/health", (c) => c.json({ ok: true }));

export default app;
