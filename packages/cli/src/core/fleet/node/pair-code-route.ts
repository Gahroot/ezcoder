// S9: POST /v1/pair (no auth). Trades a live short pairing code (made by
// `ezcoder node pair --code`) for the full pairing string. A wrong code gets
// 403 "bad_code"; more than 5 wrong codes in 10 minutes and every attempt
// gets 429 "rate_limited" until the window passes.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ErrorResponse, PairCodeRequest, PairCodeResponse } from "../protocol.js";
import { consumePairCode } from "./config.js";

export const PAIR_MAX_BAD = 5;
export const PAIR_WINDOW_MS = 10 * 60_000;
const MAX_PAIR_BODY = 4096;

export interface PairCodeRouteOptions {
  dataDir: string;
  /** Current full pairing string (reads the live token). */
  pairing: () => string;
  now?: () => number;
  log?: (msg: string) => void;
}

export const PAIR_BAD_CODE_MESSAGE =
  "pairing code is wrong, expired or already used: run `ezcoder node pair --code` for a new one";
export const PAIR_RATE_LIMITED_MESSAGE =
  "too many wrong pairing codes: wait 10 minutes, then run `ezcoder node pair --code` for a new one";

function readSmallJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_PAIR_BODY) over = true;
      else chunks.push(c);
    });
    req.on("end", () => {
      if (over) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", () => resolve(undefined));
  });
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    ...extra,
  });
  res.end(data);
}

/** Returns a handler; it answers (and returns true) only for POST /v1/pair. */
export function createPairCodeRoute(o: PairCodeRouteOptions) {
  const now = o.now ?? Date.now;
  let bad: number[] = [];
  const limited = (t: number) => {
    bad = bad.filter((x) => t - x < PAIR_WINDOW_MS);
    return bad.length >= PAIR_MAX_BAD;
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname.replace(/\/+$/, "") !== "/v1/pair" || req.method !== "POST") return false;
    const t = now();
    if (limited(t)) {
      req.resume();
      const retry = Math.max(1, Math.ceil((bad[0]! + PAIR_WINDOW_MS - t) / 1000));
      const body: ErrorResponse = { error: PAIR_RATE_LIMITED_MESSAGE, code: "rate_limited" };
      send(res, 429, body, { "retry-after": String(retry) });
      return true;
    }
    const raw = (await readSmallJson(req)) as Partial<PairCodeRequest> | undefined;
    const code = typeof raw?.code === "string" ? raw.code : "";
    if (!code || !consumePairCode(o.dataDir, code, t)) {
      bad.push(t);
      o.log?.(`pair: wrong pairing code (${bad.length} in the last 10 minutes)`);
      const body: ErrorResponse = { error: PAIR_BAD_CODE_MESSAGE, code: "bad_code" };
      send(res, 403, body);
      return true;
    }
    o.log?.("pair: a controller paired with a short code");
    const body: PairCodeResponse = { pairing: o.pairing() };
    send(res, 200, body);
    return true;
  };
}
