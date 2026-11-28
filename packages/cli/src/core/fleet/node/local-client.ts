// The node CLI talking to its own running `node serve` (status, update,
// rotate-token): finds the address it listens on and speaks http, or https
// pinned to the node's own certificate.
import { pinnedFetch, pinnedTlsAgent } from "../client.js";
import { configFingerprint, detectTailscale, isWildcardBind } from "./config.js";
import type { NodeConfig } from "./context.js";

export async function localNodeUrl(cfg: NodeConfig): Promise<string> {
  let host = cfg.bind;
  if (!host) host = (await detectTailscale()).ip ?? "127.0.0.1";
  if (isWildcardBind(host)) host = "127.0.0.1";
  const scheme = cfg.tlsCert ? "https" : "http";
  return `${scheme}://${host.includes(":") ? `[${host}]` : host}:${cfg.port}`;
}

/** fetch() against the local node with its token; https is pinned to the configured cert. */
export async function localNodeFetch(
  cfg: NodeConfig,
  p: string,
  init: { method?: string; body?: unknown; timeoutMs?: number; token?: string } = {},
): Promise<Response> {
  const fp = configFingerprint(cfg);
  const doFetch = fp ? pinnedFetch(pinnedTlsAgent(fp)) : fetch;
  return doFetch((await localNodeUrl(cfg)) + p, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${init.token ?? cfg.token}`,
      ...(init.body !== undefined && { "content-type": "application/json" }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(init.timeoutMs ?? 3000),
  });
}
