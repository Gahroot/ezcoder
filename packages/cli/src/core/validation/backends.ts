// User-level worker registry (~/.ezcoder/validation/backends.json). Projects
// never name machines; adding a worker here makes every project able to use it.
import fs from "node:fs";
import path from "node:path";
import { GitHubActionsBackend, type GitHubActionsBackendConfig } from "./github-actions-backend.js";
import { LocalBackend } from "./local-backend.js";
import { NodeBackend, type NodeBackendConfig, type NodeBackendDeps } from "./node-backend.js";
import type { Exec, Resources, ValidationBackend } from "./types.js";

export interface BackendsFile {
  /** Max jobs in flight across all backends. */
  maxConcurrent?: number;
  /** Concurrent local stages. */
  localMaxConcurrent?: number;
  backends?: Array<GitHubActionsBackendConfig | NodeBackendConfig>;
  /** Use every paired fleet node (~/.ezcoder/fleet/nodes.json) as a pool "fleet". */
  fleetNodes?: boolean;
}

export function backendsFilePath(dir: string): string {
  return path.join(dir, "backends.json");
}

export function readBackendsFile(dir: string): BackendsFile {
  try {
    return JSON.parse(fs.readFileSync(backendsFilePath(dir), "utf8")) as BackendsFile;
  } catch {
    return {};
  }
}

export function writeBackendsFile(dir: string, data: BackendsFile): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(backendsFilePath(dir), JSON.stringify(data, null, 2) + "\n");
}

/** Build backends from config. Unknown kinds are skipped with a reason. */
export function loadBackends(
  dir: string,
  exec: Exec,
  nodeDeps?: Partial<NodeBackendDeps>,
): { backends: ValidationBackend[]; maxConcurrent: number; problems: string[] } {
  const file = readBackendsFile(dir);
  const problems: string[] = [];
  const backends: ValidationBackend[] = [
    new LocalBackend(path.join(dir, "logs"), file.localMaxConcurrent ?? 2),
  ];
  for (const cfg of file.backends ?? []) {
    if (cfg.kind === "github-actions" && cfg.id && cfg.repo && cfg.workflow) {
      if (cfg.id === "local" || backends.some((b) => b.id === cfg.id)) {
        problems.push(`duplicate backend id "${cfg.id}"`);
        continue;
      }
      if (cfg.cloud?.enabled && !cfg.discover) {
        problems.push(`backend "${cfg.id}": "cloud" needs "discover": true; cloud ignored`);
      }
      backends.push(new GitHubActionsBackend(cfg, exec));
    } else if (cfg.kind === "node") {
      const id = cfg.id ?? "fleet";
      if (id === "local" || backends.some((b) => b.id === id)) {
        problems.push(`duplicate backend id "${id}"`);
        continue;
      }
      backends.push(new NodeBackend({ ...cfg, id }, nodeDeps));
    } else {
      problems.push(
        `backend "${String(cfg.id)}": unsupported or incomplete (kind ${String(cfg.kind)})`,
      );
    }
  }
  // Every paired node, unless an explicit node entry already took the "fleet" id.
  if (file.fleetNodes && !backends.some((b) => b.id === "fleet")) {
    backends.push(new NodeBackend({ kind: "node", id: "fleet" }, nodeDeps));
  }
  return { backends, maxConcurrent: Math.max(1, file.maxConcurrent ?? 4), problems };
}

/** Does a backend's declared capacity cover what a stage asks for? */
export function fits(need: Resources | undefined, have: Resources | undefined): boolean {
  if (!need) return true;
  if (need.cpus && have?.cpus !== undefined && need.cpus > have.cpus) return false;
  if (need.memoryGb && have?.memoryGb !== undefined && need.memoryGb > have.memoryGb) return false;
  const labels = (have?.labels ?? []).map((l) => l.toLowerCase());
  return (need.labels ?? []).every((l) => labels.includes(l.toLowerCase()));
}
