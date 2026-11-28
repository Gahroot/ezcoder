// Seam between the node HTTP server (server.ts) and route modules owned by
// separate features (agents.ts). The server builds one NodeContext and offers
// every request to each module in turn.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { AgentWorkspaceStatus, SourceSpec } from "../protocol.js";
import type { StateStore } from "./state.js";

export interface NodeConfig {
  name: string;
  /** Bearer token the controller must present. */
  token: string;
  port: number;
  /** Address to listen on (Tailscale IP by default). */
  bind: string;
  /** Public host the controller uses for service endpoints (MagicDNS name or tailnet IP). */
  advertiseHost: string;
  labels: string[];
  slots: number;
  /** Root for workspaces, caches, artifacts, state (default ~/.ezcoder/node). */
  dataDir: string;
  /** X5: refuse host-shell jobs and remote agents (`serve --docker-only`). */
  dockerOnly?: boolean;
  /** X10: serve https with this PEM cert + key. */
  tlsCert?: string;
  tlsKey?: string;
  /** R5: finished jobs, logs and artifacts older than this are removed (default 7). */
  gcDays?: number;
  /** R5: caches beyond this total size are trimmed, least recently used first (default 20). */
  cacheCapGb?: number;
}

export interface NodeContext {
  config: NodeConfig;
  /** Take one job/agent slot; false when full. Release exactly once. */
  acquireSlot(owner: string, force?: boolean): boolean;
  releaseSlot(owner: string): void;
  /**
   * Fresh isolated workspace at exactly source.sha (+ patch). Returns its path.
   * Uses the node's own git credentials (gh auth / ssh).
   */
  prepareWorkspace(
    kind: "job" | "agent" | "service",
    id: string,
    source: SourceSpec,
  ): Promise<string>;
  /** Absolute path of the node's ezcoder CLI entry, for spawning `--subagent-worker`. */
  cliEntry(): string;
  /** Write JSON with status; ends the response. */
  json(res: ServerResponse, status: number, body: unknown): void;
  log(msg: string): void;
  /** Durable node state; route modules persist their records here (R3). */
  state?: StateStore;
}

/** A feature's routes. Return true when the request was handled. */
export interface NodeRouteModule {
  handle(ctx: NodeContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** WebSocket upgrade; return true when handled. Auth is already checked. */
  upgrade?(ctx: NodeContext, req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean;
  /** Snapshot for GET /v1/info. */
  agents?(): AgentWorkspaceStatus[];
  /** Called once after the server starts (R3: re-adopt persisted records). */
  init?(ctx: NodeContext): Promise<void> | void;
  /** S4: the token changed; close every connection opened with the old one. */
  tokenRotated?(): void;
  /** Number of running workers (S7 refuses updates while > 0). */
  activeCount?(): number;
  /** Called once at shutdown. */
  close?(): Promise<void>;
}
