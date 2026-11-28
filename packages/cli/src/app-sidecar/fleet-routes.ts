// Machines panel and fleet activity for the desktop app (PRD 8.5, D1–D5).
// Every call goes through fleet-adapter.ts, the app's only door into core/fleet.
import type http from "node:http";
import { log } from "../core/logger.js";
import { fleetAdapter, FleetUserError, type FleetAdapter } from "./fleet-adapter.js";
import { json, readBody } from "./http.js";
import type { SessionRouteContext } from "./route-context.js";

type Body = Record<string, unknown>;

function parse(raw: string): Body | null {
  try {
    const v = JSON.parse(raw || "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Body) : null;
  } catch {
    return null;
  }
}

function str(body: Body, key: string): string {
  const v = body[key];
  return typeof v === "string" ? v.trim() : "";
}

function fail(res: http.ServerResponse, error: unknown, what: string): void {
  if (res.destroyed) return;
  if (error instanceof FleetUserError) {
    json(res, 400, { error: error.message });
    return;
  }
  log("WARN", "app-sidecar", `fleet ${what} failed`, { error: String(error) });
  json(res, 502, { error: error instanceof Error ? error.message : String(error) });
}

/** Read the JSON body, run `fn`, answer with its result (or a plain error). */
function withBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  what: string,
  fn: (body: Body) => Promise<unknown>,
): void {
  void readBody(req, res).then(async (raw) => {
    if (raw === null) return;
    const body = parse(raw);
    if (!body) {
      json(res, 400, { error: "invalid JSON body" });
      return;
    }
    try {
      const out = await fn(body);
      if (!res.destroyed) json(res, 200, out);
    } catch (e) {
      fail(res, e, what);
    }
  });
}

function needName(body: Body): string {
  const name = str(body, "name");
  if (!name) throw new FleetUserError("Pick a machine first.");
  return name;
}

export function handleFleetRoutes(
  ctx: Pick<SessionRouteContext, "cwd">,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
  adapter: FleetAdapter = fleetAdapter(),
): boolean {
  if (!url.startsWith("/fleet/")) return false;

  if (method === "GET" && url === "/fleet/machines") {
    void adapter.overview().then(
      (overview) => {
        if (!res.destroyed) json(res, 200, { ...overview, version: adapter.version() });
      },
      (e: unknown) => fail(res, e, "machines"),
    );
    return true;
  }

  if (method === "GET" && url === "/fleet/activity") {
    void adapter.activity(ctx.cwd).then(
      (activity) => {
        if (!res.destroyed) json(res, 200, activity);
      },
      (e: unknown) => fail(res, e, "activity"),
    );
    return true;
  }

  if (method !== "POST") return false;

  switch (url) {
    case "/fleet/machines/add":
      withBody(req, res, "add", (b) =>
        adapter.addMachine(str(b, "pairing"), { offline: b.offline === true }),
      );
      return true;
    case "/fleet/machines/remove":
      withBody(req, res, "remove", async (b) => ({
        removed: await adapter.removeMachine(needName(b)),
      }));
      return true;
    case "/fleet/machines/rotate-token":
      withBody(req, res, "rotate-token", async (b) => {
        await adapter.rotateMachineToken(needName(b));
        return { rotated: true };
      });
      return true;
    case "/fleet/machines/share-auth":
      withBody(req, res, "share-auth", (b) =>
        adapter.shareAuth(needName(b), { force: b.force === true }),
      );
      return true;
    case "/fleet/machines/doctor":
      withBody(req, res, "doctor", (b) => adapter.doctor(needName(b)));
      return true;
    case "/fleet/log":
      withBody(req, res, "log", async (b) => {
        const id = str(b, "id");
        if (!id) throw new FleetUserError("missing id");
        const tail = Math.min(2000, Math.max(1, Number(b.tail) || 200));
        const text =
          b.kind === "service"
            ? await adapter.serviceLog(id, tail)
            : await adapter.jobLog(id, tail);
        return { text };
      });
      return true;
    default:
      return false;
  }
}
