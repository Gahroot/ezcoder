// The user's paired nodes (~/.ezcoder/fleet/nodes.json, 0600: it holds tokens).
// Pairing strings come from `ezcoder node serve` on the other machine:
//   ezfleet://<name>@<host>:<port>#<token>
//   ezfleets://<name>@<host>:<port>#<token>;fp=<sha-256 of the cert, 64 hex> (TLS, X10)
import { DEFAULT_NODE_PORT } from "./protocol.js";
import { defaultFleetDir, JsonListStore } from "./store.js";

export interface FleetNode {
  name: string;
  /** Base URL, e.g. http://my-pc.tailnet.ts.net:7377 */
  url: string;
  token: string;
  /** Extra controller-side labels (the node reports its own too). */
  labels: string[];
  addedAt: string;
  /** Pinned SHA-256 of the node's TLS certificate (64 lowercase hex) for https nodes (X10). */
  fingerprint?: string;
}

export interface Pairing {
  name: string;
  host: string;
  port: number;
  url: string;
  token: string;
  /** TLS pin from an `ezfleets://` string. */
  fingerprint?: string;
}

const NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export function isValidNodeName(name: string): boolean {
  return NODE_NAME.test(name);
}

/** Normalise a SHA-256 fingerprint ("AB:CD:…" or hex) to 64 lowercase hex, or undefined. */
export function normalizeFingerprint(fp: string | undefined): string | undefined {
  if (!fp) return undefined;
  const hex = fp.replace(/[:\s]/g, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
}

/**
 * Parse `ezfleet://<name>@<host>[:<port>]#<token>` or the TLS form
 * `ezfleets://<name>@<host>[:<port>]#<token>;fp=<64 hex>`; throws a plain-words error.
 */
export function parsePairing(input: string): Pairing {
  const s = input.trim();
  const m =
    /^ezfleet(s)?:\/\/([^@/#\s]+)@(\[[^\]\s]+\]|[^:/#\s]+)(?::(\d{1,5}))?\/?#([^;\s]+)(?:;fp=(\S*))?$/i.exec(
      s,
    );
  if (!m) {
    throw new Error(
      `not a pairing string: expected ezfleet://<name>@<host>:<port>#<token> (got "${s.slice(0, 60)}")`,
    );
  }
  const tls = !!m[1];
  const name = decodeURIComponent(m[2]!);
  const host = m[3]!;
  const port = m[4] ? Number(m[4]) : DEFAULT_NODE_PORT;
  const token = m[5]!;
  if (!isValidNodeName(name)) throw new Error(`invalid node name "${name}"`);
  if (port < 1 || port > 65_535) throw new Error(`invalid port ${port}`);
  if (token.length < 16) throw new Error("pairing token is too short");
  if (m[6] !== undefined && !tls) {
    throw new Error("a certificate fingerprint (;fp=) needs an ezfleets:// (TLS) pairing string");
  }
  if (!tls) return { name, host, port, url: `http://${host}:${port}`, token };
  const fingerprint = normalizeFingerprint(m[6]);
  if (!fingerprint) {
    throw new Error(
      "TLS pairing string needs the node's certificate fingerprint: ezfleets://<name>@<host>:<port>#<token>;fp=<64 hex>",
    );
  }
  return { name, host, port, url: `https://${host}:${port}`, token, fingerprint };
}

export class NodeRegistry {
  private readonly store: JsonListStore<FleetNode>;
  constructor(readonly dir: string = defaultFleetDir()) {
    this.store = new JsonListStore<FleetNode>(dir, "nodes.json", "nodes", { mode: 0o600 });
  }

  get file(): string {
    return this.store.file;
  }

  async list(): Promise<FleetNode[]> {
    return (await this.store.read()).filter(
      (n) => n && typeof n.name === "string" && typeof n.url === "string",
    );
  }

  async get(name: string): Promise<FleetNode | undefined> {
    return (await this.list()).find((n) => n.name === name);
  }

  /** Add or replace (same name) a node. */
  async add(node: Omit<FleetNode, "addedAt"> & { addedAt?: string }): Promise<FleetNode> {
    if (!isValidNodeName(node.name)) throw new Error(`invalid node name "${node.name}"`);
    const entry: FleetNode = {
      name: node.name,
      url: node.url.replace(/\/+$/, ""),
      token: node.token,
      labels: node.labels ?? [],
      addedAt: node.addedAt ?? new Date().toISOString(),
      ...(node.fingerprint ? { fingerprint: node.fingerprint } : {}),
    };
    await this.store.update((nodes) => {
      const i = nodes.findIndex((n) => n.name === entry.name);
      if (i >= 0) nodes[i] = entry;
      else nodes.push(entry);
    });
    return entry;
  }

  /** Replace a node's token (after `rotate-token`); false when the name isn't paired. */
  async setToken(name: string, token: string): Promise<boolean> {
    return this.store.update((nodes) => {
      const n = nodes.find((x) => x.name === name);
      if (!n) return false;
      n.token = token;
      return true;
    });
  }

  async remove(name: string): Promise<boolean> {
    return this.store.update((nodes) => {
      const i = nodes.findIndex((n) => n.name === name);
      if (i < 0) return false;
      nodes.splice(i, 1);
      return true;
    });
  }
}

/** Every paired node (for other modules: remote agents, validation). */
export async function listNodes(dir?: string): Promise<FleetNode[]> {
  return new NodeRegistry(dir).list();
}
