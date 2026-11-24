// Find EZCODER nodes on the tailnet: online peers from `tailscale status --json`,
// each probed on GET /v1/hello with a short timeout.
import { defaultExec } from "../validation/exec.js";
import type { Exec } from "../validation/types.js";
import { FleetClient } from "./client.js";
import { DEFAULT_NODE_PORT, type NodePlatform } from "./protocol.js";
import { NodeRegistry } from "./registry.js";

export interface TailscalePeer {
  hostName: string;
  /** MagicDNS name without the trailing dot ("" when MagicDNS is off). */
  dnsName: string;
  ips: string[];
  os?: string;
}

export interface FoundNode {
  /** Name the node reports. */
  name: string;
  host: string;
  url: string;
  platform: NodePlatform;
  version: string;
  protocol: number;
  /** Already in nodes.json (by name or URL). */
  paired: boolean;
  peer: string;
}

export interface DiscoverOptions {
  exec?: Exec;
  fetch?: typeof fetch;
  port?: number;
  timeoutMs?: number;
  /** Fleet dir with nodes.json (tests). */
  dir?: string;
}

const TAILSCALE_BINS = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/local/bin/tailscale",
];

/** Online peers from `tailscale status --json` output. */
export function parseTailscaleStatus(json: string): TailscalePeer[] {
  let data: { Peer?: Record<string, Record<string, unknown>> };
  try {
    data = JSON.parse(json) as typeof data;
  } catch {
    throw new Error("could not read `tailscale status --json` output");
  }
  const peers: TailscalePeer[] = [];
  for (const p of Object.values(data.Peer ?? {})) {
    if (!p || p.Online !== true) continue;
    const ips = Array.isArray(p.TailscaleIPs)
      ? (p.TailscaleIPs as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    peers.push({
      hostName: typeof p.HostName === "string" ? p.HostName : "",
      dnsName: typeof p.DNSName === "string" ? p.DNSName.replace(/\.$/, "") : "",
      ips,
      ...(typeof p.OS === "string" ? { os: p.OS } : {}),
    });
  }
  return peers;
}

async function tailscaleStatus(exec: Exec): Promise<string> {
  let last = "";
  for (const bin of TAILSCALE_BINS) {
    const r = await exec(bin, ["status", "--json"], { timeoutMs: 10_000 });
    if (r.code === 0 && r.stdout.trim()) return r.stdout;
    last = (r.stderr || r.stdout).trim();
  }
  throw new Error(
    `tailscale isn't available or not logged in${last ? ` (${last.slice(0, 200)})` : ""}; install Tailscale on this machine and run \`tailscale up\``,
  );
}

/** Probe every online peer; returns the ones answering as EZCODER nodes. */
export async function discoverNodes(opts: DiscoverOptions = {}): Promise<FoundNode[]> {
  const exec = opts.exec ?? defaultExec;
  const port = opts.port ?? DEFAULT_NODE_PORT;
  const timeoutMs = opts.timeoutMs ?? 1500;
  const peers = parseTailscaleStatus(await tailscaleStatus(exec));
  const paired = await new NodeRegistry(opts.dir).list();
  const found = await Promise.all(
    peers.map(async (peer): Promise<FoundNode | undefined> => {
      const hosts = [peer.dnsName, ...peer.ips.filter((ip) => !ip.includes(":"))].filter(Boolean);
      for (const host of hosts) {
        const url = `http://${host}:${port}`;
        try {
          const h = await new FleetClient(peer.hostName || host, url, undefined, {
            timeoutMs,
            ...(opts.fetch ? { fetch: opts.fetch } : {}),
          }).hello(timeoutMs);
          return {
            name: h.name,
            host,
            url,
            platform: h.platform,
            version: h.version,
            protocol: h.protocol,
            paired: paired.some(
              (n) =>
                n.name === h.name || n.url === url || hosts.some((x) => n.url.includes(`//${x}:`)),
            ),
            peer: peer.hostName || host,
          };
        } catch {
          // not a node, or not on this host name: try the next address
        }
      }
      return undefined;
    }),
  );
  return found.filter((f): f is FoundNode => !!f);
}
