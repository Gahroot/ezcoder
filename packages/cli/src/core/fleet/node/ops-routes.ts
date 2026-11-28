// Node self-service routes (authenticated): GET /v1/doctor (S1/A4) and
// POST /v1/update (S7). A NodeRouteModule so server.ts only registers it.
import type { IncomingMessage } from "node:http";
import type { DoctorReport, ErrorResponse, UpdateRequest } from "../protocol.js";
import type { NodeContext, NodeRouteModule } from "./context.js";
import { runDoctor, type DoctorOptions } from "./doctor.js";
import { installUpdate, scheduleRestart, UpdateError, type UpdateOptions } from "./update.js";

export interface OpsRouteOptions {
  /** Jobs + agents running now (updates are refused while > 0 unless forced). */
  activeWork: () => number;
  /** Doctor probes (tests); config and repo are filled in per request. */
  doctor?: Omit<DoctorOptions, "config" | "repo">;
  /** Replaces runDoctor entirely (tests). */
  runDoctor?: (o: DoctorOptions) => Promise<DoctorReport>;
  update?: Omit<UpdateOptions, "request" | "activeWork" | "log">;
  modelProviders?: () => Promise<string[]>;
}

function readJson(req: IncomingMessage, limit = 16 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on("end", () => {
      if (size > limit) return reject(new UpdateError(413, "request body too large"));
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new UpdateError(400, "invalid JSON body", "bad_request"));
      }
    });
    req.on("error", reject);
  });
}

export function createOpsRouteModule(o: OpsRouteOptions): NodeRouteModule {
  let updating = false;
  return {
    async handle(ctx: NodeContext, req, res, url) {
      const p = url.pathname.replace(/\/+$/, "");
      if (p === "/v1/doctor" && req.method === "GET") {
        const repo = url.searchParams.get("repo") ?? undefined;
        const report = await (o.runDoctor ?? runDoctor)({
          modelProviders: o.modelProviders,
          ...o.doctor,
          config: ctx.config,
          ...(repo && { repo }),
        });
        ctx.json(res, 200, report);
        return true;
      }
      if (p === "/v1/update" && req.method === "POST") {
        if (updating) {
          req.resume();
          ctx.json(res, 409, { error: "an update is already running on this node" });
          return true;
        }
        updating = true;
        try {
          const body = (await readJson(req)) as UpdateRequest;
          const request: UpdateRequest = {
            ...(typeof body?.version === "string" && { version: body.version }),
            ...(body?.force === true && { force: true }),
          };
          const r = await installUpdate({
            ...o.update,
            request,
            activeWork: o.activeWork,
            log: ctx.log,
          });
          ctx.json(res, 202, r);
          if (r.restarting) scheduleRestart({ restart: o.update?.restart, log: ctx.log });
        } catch (e) {
          const status = e instanceof UpdateError ? e.status : 500;
          const body: ErrorResponse = {
            error: (e as Error).message,
            ...(e instanceof UpdateError && e.code && { code: e.code }),
          };
          ctx.json(res, status, body);
        } finally {
          updating = false;
        }
        return true;
      }
      return false;
    },
  };
}
