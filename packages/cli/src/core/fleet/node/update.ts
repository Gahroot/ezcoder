// S7: `ezcoder node update` and POST /v1/update. The node installs the
// requested CLI version with npm (user-level global prefix), then restarts:
// under its login service (systemd Restart=always / launchd KeepAlive) that
// is simply exiting; otherwise the user restarts `node serve` themselves.
import type { UpdateRequest, UpdateResponse } from "../protocol.js";
import { defaultExec, type NodeExec } from "./exec.js";
import { cliVersion } from "./info.js";

export const CLI_PACKAGE = "@prestyj/cli";
const VERSION_RE = /^(latest|next|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

export class UpdateError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: "bad_request",
  ) {
    super(message);
  }
}

export interface UpdateOptions {
  request: UpdateRequest;
  /** Jobs + agents currently running on this node. */
  activeWork: () => number;
  exec?: NodeExec;
  npm?: string;
  currentVersion?: string;
  /** True when a service manager will start the node again after it exits. */
  underService?: () => boolean;
  /** Restart now (default: exit, so the service manager starts the new version). */
  restart?: () => void;
  log?: (msg: string) => void;
}

/** systemd sets INVOCATION_ID for every unit; launchd sets XPC_SERVICE_NAME to the label. */
export function runningUnderService(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.INVOCATION_ID) || env.XPC_SERVICE_NAME === "dev.ezcoder.node";
}

export function updateBusyMessage(n: number): string {
  return `${n} job(s) or agent(s) are running on this node; wait for them to finish, or update with --force (they are stopped by the restart)`;
}

/** Install `request.version` (default latest). Throws UpdateError with an HTTP status. */
export async function installUpdate(o: UpdateOptions): Promise<UpdateResponse> {
  const exec = o.exec ?? defaultExec;
  const npm = o.npm ?? (process.platform === "win32" ? "npm.cmd" : "npm");
  const wanted = (o.request.version ?? "latest").trim().replace(/^v/, "");
  if (!VERSION_RE.test(wanted)) {
    throw new UpdateError(
      400,
      `"${wanted.slice(0, 40)}" is not a version: use something like 5.38.0, or latest`,
      "bad_request",
    );
  }
  const busy = o.activeWork();
  if (busy > 0 && !o.request.force) throw new UpdateError(409, updateBusyMessage(busy));
  const from = o.currentVersion ?? cliVersion();

  const view = await exec(npm, ["view", `${CLI_PACKAGE}@${wanted}`, "version"], {
    timeoutMs: 60_000,
  });
  if (view.code === 127) {
    throw new UpdateError(500, "npm is not installed on this node, so it can't update itself");
  }
  const to = view.stdout.trim().split(/\s+/).pop() ?? "";
  if (view.code !== 0 || !to) {
    throw new UpdateError(
      400,
      `npm has no ${CLI_PACKAGE}@${wanted}: ${(view.stderr || view.stdout).trim().slice(-300)}`,
      "bad_request",
    );
  }
  if (to === from) return { from, to, restarting: false };

  o.log?.(`update: installing ${CLI_PACKAGE}@${to} (was ${from})`);
  const r = await exec(npm, ["install", "-g", `${CLI_PACKAGE}@${to}`], { timeoutMs: 600_000 });
  if (r.code !== 0) {
    throw new UpdateError(
      500,
      `npm install -g ${CLI_PACKAGE}@${to} failed: ${(r.stderr || r.stdout).trim().slice(-500)}`,
    );
  }
  const restarting = (o.underService ?? runningUnderService)();
  return { from, to, restarting };
}

/** Exit shortly after the response is sent, so the service manager starts the new CLI. */
export function scheduleRestart(o: Pick<UpdateOptions, "restart" | "log">, delayMs = 500): void {
  const restart =
    o.restart ??
    (() => {
      o.log?.("update: restarting into the new version");
      process.exit(0);
    });
  setTimeout(restart, delayMs);
}
