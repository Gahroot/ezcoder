import type http from "node:http";
import { randomUUID } from "node:crypto";
import {
  loadTasksSync,
  saveTasksSync,
  pruneDoneTasksSync,
  type TaskStatus,
} from "../core/task-store.js";
import { readChecklistSnapshot } from "../core/checklist-snapshot.js";
import { log } from "../core/logger.js";
import {
  RADIO_STATIONS,
  getCurrentStation,
  getRadioVolume,
  playRadio,
  setRadioVolume,
  stopRadio,
} from "../core/radio.js";
import { readBody, json } from "./http.js";
import type { SessionRouteContext } from "./route-context.js";

export function handleTaskRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  if (method === "GET" && url === "/tasks") {
    json(res, 200, { tasks: pruneDoneTasksSync(ctx.cwd) });
    return true;
  }

  if (method === "GET" && url === "/checklist") {
    const controller = new AbortController();
    res.once("close", () => controller.abort());
    void (async () => {
      try {
        const result = await readChecklistSnapshot(ctx.cwd, new Date(), controller.signal);
        if (res.destroyed) return;
        if (!result.ok) {
          log("WARN", "app-sidecar", "checklist read failed", { error: result.error });
          json(res, 500, { error: result.error });
          return;
        }
        json(res, 200, result.value);
      } catch (error) {
        log("WARN", "app-sidecar", "checklist snapshot failed", { error: String(error) });
        if (!res.destroyed) json(res, 500, { error: "Could not read the project checklist" });
      }
    })();
    return true;
  }

  // ── Radio (app-wide) ──────────────────────────────────────
  // Radio is now APP-WIDE: all windows share one daemon process, and the
  // player lives in `core/radio.ts` module-level singletons (one stream for
  // the whole app). Any window's /radio reads/controls that single stream —
  // starting a station in one window replaces whatever was playing, and every
  // window's footer reflects the same `current`. This intentionally prevents
  // duplicate audio across windows (the original per-window goal), now for
  // free. (To restore per-window radio, key playback by sessionId.)
  if (method === "GET" && url === "/radio") {
    json(res, 200, {
      stations: RADIO_STATIONS,
      current: getCurrentStation(),
      volume: getRadioVolume(),
    });
    return true;
  }

  if (method === "POST" && url === "/radio/volume") {
    void readBody(req, res).then((raw) => {
      if (raw === null) return;
      let volume: number;
      try {
        volume = Number((JSON.parse(raw) as { volume?: number }).volume);
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (!Number.isFinite(volume)) {
        json(res, 400, { error: "volume must be a number" });
        return;
      }
      const result = setRadioVolume(volume);
      if (!result.ok) {
        json(res, 400, { error: result.error ?? "Radio volume failed to update." });
        return;
      }
      json(res, 200, { current: getCurrentStation(), volume: getRadioVolume() });
    });
    return true;
  }

  if (method === "POST" && url === "/radio") {
    void readBody(req, res).then((raw) => {
      if (raw === null) return;
      let station: string;
      try {
        station = (JSON.parse(raw) as { station?: string }).station ?? "";
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (!station || station === "off") {
        stopRadio();
        json(res, 200, { current: null });
        return;
      }
      const result = playRadio(station);
      if (!result.ok) {
        json(res, 400, { error: result.error ?? "Radio failed to start." });
        return;
      }
      json(res, 200, { current: getCurrentStation() });
    });
    return true;
  }

  if (method === "POST" && url === "/tasks/run") {
    void readBody(req, res).then((raw) => {
      if (raw === null) return;
      let id: string | null;
      let all: boolean;
      try {
        const body = JSON.parse(raw) as { id?: string | null; all?: boolean };
        id = body.id ?? null;
        all = Boolean(body.all);
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (ctx.running) {
        json(res, 409, { error: "cannot run a task while the agent is running" });
        return;
      }
      json(res, 202, { accepted: true });
      void ctx.runTasks(id, all);
    });
    return true;
  }

  if (method === "POST" && url === "/tasks/add") {
    void readBody(req, res).then((raw) => {
      if (raw === null) return;
      let title: string;
      let prompt: string;
      try {
        const body = JSON.parse(raw) as { title?: string; prompt?: string };
        title = (body.title ?? "").trim();
        prompt = (body.prompt ?? "").trim();
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (!title) {
        json(res, 400, { error: "missing task title" });
        return;
      }
      const tasks = loadTasksSync(ctx.cwd);
      const newTask = {
        id: randomUUID(),
        title,
        prompt: prompt || title,
        status: "pending" as const,
        createdAt: new Date().toISOString(),
      };
      const next = [...tasks, newTask];
      saveTasksSync(ctx.cwd, next);
      ctx.broadcast("tasks_list", { tasks: next });
      json(res, 200, { tasks: next });
    });
    return true;
  }

  if (method === "POST" && url === "/tasks/update") {
    void readBody(req, res).then((raw) => {
      if (raw === null) return;
      let id: string;
      let status: string | undefined;
      let title: string | undefined;
      let prompt: string | undefined;
      try {
        const body = JSON.parse(raw) as {
          id?: string;
          status?: string;
          title?: string;
          prompt?: string;
        };
        id = (body.id ?? "").trim();
        status = body.status;
        title = body.title;
        prompt = body.prompt;
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (!id) {
        json(res, 400, { error: "missing task id" });
        return;
      }
      if (status && status !== "pending" && status !== "in-progress" && status !== "done") {
        json(res, 400, { error: `invalid status: ${status}` });
        return;
      }
      const tasks = loadTasksSync(ctx.cwd);
      const task = tasks.find((t) => t.id === id || t.id.startsWith(id));
      if (!task) {
        json(res, 404, { error: `no task found matching id "${id}"` });
        return;
      }
      const next = tasks.map((t) =>
        t.id === task.id
          ? {
              ...t,
              ...(status ? { status: status as TaskStatus } : {}),
              ...(typeof title === "string" && title.trim() ? { title: title.trim() } : {}),
              ...(typeof prompt === "string" && prompt.trim() ? { prompt: prompt.trim() } : {}),
            }
          : t,
      );
      saveTasksSync(ctx.cwd, next);
      ctx.broadcast("tasks_list", { tasks: next });
      json(res, 200, { tasks: next });
    });
    return true;
  }

  if (method === "POST" && url === "/tasks/delete") {
    void readBody(req, res).then((raw) => {
      if (raw === null) return;
      let id: string;
      try {
        id = (JSON.parse(raw) as { id?: string }).id ?? "";
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (!id.trim()) {
        json(res, 400, { error: "missing task id" });
        return;
      }
      const remaining = loadTasksSync(ctx.cwd).filter((t) => t.id !== id && !t.id.startsWith(id));
      saveTasksSync(ctx.cwd, remaining);
      ctx.broadcast("tasks_list", { tasks: remaining });
      json(res, 200, { tasks: remaining });
    });
    return true;
  }

  return false;
}
