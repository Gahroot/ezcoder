// The user's paired nodes (~/.ezcoder/fleet/nodes.json, 0600: it holds tokens).
// Pairing strings come from `ezcoder node serve` on the other machine:
//   ezfleet://<name>@<host>:<port>#<token>
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
}

export interface Pairing {
  name: string;
  host: string;
  port: number;
  url: string;
  token: string;
}

const NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export function isValidNodeName(name: string): boolean {
  return NODE_NAME.test(name);
}

/** Parse `ezfleet://<name>@<host>[:<port>]#<token>`; throws a plain-words error. */
export function parsePairing(input: string): Pairing {
  const s = input.trim();
  const m = /^ezfleet:\/\/([^@/#\s]+)@(\[[^\]\s]+\]|[^:/#\s]+)(?::(\d{1,5}))?\/?#(\S+)$/i.exec(s);
  if (!m) {
    throw new Error(
      `not a pairing string: expected ezfleet://<name>@<host>:<port>#<token> (got "${s.slice(0, 60)}")`,
    );
  }
  const name = decodeURIComponent(m[1]!);
  const host = m[2]!;
  const port = m[3] ? Number(m[3]) : DEFAULT_NODE_PORT;
  const token = m[4]!;
  if (!isValidNodeName(name)) throw new Error(`invalid node name "${name}"`);
  if (port < 1 || port > 65_535) throw new Error(`invalid port ${port}`);
  if (token.length < 16) throw new Error("pairing token is too short");
  return { name, host, port, url: `http://${host}:${port}`, token };
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
    };
    await this.store.update((nodes) => {
      const i = nodes.findIndex((n) => n.name === entry.name);
      if (i >= 0) nodes[i] = entry;
      else nodes.push(entry);
    });
    return entry;
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
