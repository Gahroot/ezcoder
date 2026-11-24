// Seam between the node HTTP server (server.ts) and route modules owned by
// separate features (agents.ts). The server builds one NodeContext and offers
// every request to each module in turn.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { AgentWorkspaceStatus, SourceSpec } from "../protocol.js";

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
}

export interface NodeContext {
  config: NodeConfig;
  /** Take one job/agent slot; false when full. Release exactly once. */
  acquireSlot(owner: string): boolean;
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
}

/** A feature's routes. Return true when the request was handled. */
export interface NodeRouteModule {
  handle(ctx: NodeContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** WebSocket upgrade; return true when handled. Auth is already checked. */
  upgrade?(ctx: NodeContext, req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean;
  /** Snapshot for GET /v1/info. */
  agents?(): AgentWorkspaceStatus[];
  /** Called once at shutdown. */
  close?(): Promise<void>;
}
