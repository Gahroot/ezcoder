// User-level worker registry (~/.ezcoder/validation/backends.json). Projects
// never name machines; adding a worker here makes every project able to use it.
import fs from "node:fs";
import path from "node:path";
import { readCloudSettings, type CloudSettings } from "../cloud/config.js";
import {
  CLOUD_BACKEND_ID,
  CloudValidationBackend,
  cloudValidationEnabled,
  type CloudBackendDeps,
} from "./cloud-backend.js";
import { GitHubActionsBackend, type GitHubActionsBackendConfig } from "./github-actions-backend.js";
import { LocalBackend } from "./local-backend.js";
import { NodeBackend, type NodeBackendConfig, type NodeBackendDeps } from "./node-backend.js";
import type { Exec, Resources, ValidationBackend } from "./types.js";

export interface BackendsFile {
  /**
   * Max jobs in flight across all backends. Unset: the real total capacity
   * (local slots plus every online machine's slots), recomputed each pass.
   */
  maxConcurrent?: number;
  /** Concurrent local stages. */
  localMaxConcurrent?: number;
  backends?: Array<GitHubActionsBackendConfig | NodeBackendConfig>;
  /**
   * Use every paired fleet node (~/.ezcoder/fleet/nodes.json) as a pool
   * "fleet". On by default whenever a node is paired; false turns it off.
   */
  fleetNodes?: boolean;
  /**
   * Cloud agent sandboxes (Claude Code cloud, Codex cloud) as overflow
   * capacity. On by default when signed in; false turns them off here.
   */
  cloud?: boolean;
}

export interface CloudBackendOptions {
  /** Cloud settings (default ~/.ezcoder/cloud.json). */
  settings?: CloudSettings;
  deps?: Partial<CloudBackendDeps>;
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

/** The fleet folder next to a validation folder (~/.ezcoder/fleet beside ~/.ezcoder/validation). */
export function siblingFleetDir(validationDir: string): string {
  return path.join(path.dirname(validationDir), "fleet");
}

/** Is any fleet node paired? (sync read of nodes.json) */
export function fleetNodesPaired(fleetDir: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(fleetDir, "nodes.json"), "utf8")) as {
      nodes?: unknown[];
    };
    return Array.isArray(raw.nodes) && raw.nodes.length > 0;
  } catch {
    return false;
  }
}

export const DEFAULT_LOCAL_SLOTS = 2;

/**
 * Build backends from config. Unknown kinds are skipped with a reason.
 * `maxConcurrent` is the explicit cap from the file, or undefined: then the
 * service uses the real total capacity of its targets.
 */
export function loadBackends(
  dir: string,
  exec: Exec,
  nodeDeps?: Partial<NodeBackendDeps>,
  cloud: CloudBackendOptions = {},
  opts: { fleetDir?: string } = {},
): { backends: ValidationBackend[]; maxConcurrent?: number; problems: string[] } {
  const file = readBackendsFile(dir);
  const problems: string[] = [];
  const backends: ValidationBackend[] = [
    new LocalBackend(path.join(dir, "logs"), file.localMaxConcurrent ?? DEFAULT_LOCAL_SLOTS),
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
  // On by default once a node is paired; `"fleetNodes": false` turns it off.
  const useFleet = file.fleetNodes ?? fleetNodesPaired(opts.fleetDir ?? siblingFleetDir(dir));
  if (useFleet && !backends.some((b) => b.id === "fleet")) {
    backends.push(new NodeBackend({ kind: "node", id: "fleet" }, nodeDeps));
  }
  // Zero config: cloud overflow whenever the user is signed in (checked lazily).
  const cloudSettings = cloud.settings ?? readCloudSettings();
  if (file.cloud !== false && cloudValidationEnabled(cloudSettings)) {
    if (backends.some((b) => b.id === CLOUD_BACKEND_ID)) {
      problems.push(
        `backend id "${CLOUD_BACKEND_ID}" is reserved for cloud overflow; cloud skipped`,
      );
    } else {
      backends.push(
        new CloudValidationBackend(path.join(dir, "logs"), {
          settings: () => cloud.settings ?? readCloudSettings(),
          ...cloud.deps,
        }),
      );
    }
  }
  return {
    backends,
    ...(file.maxConcurrent !== undefined ? { maxConcurrent: Math.max(1, file.maxConcurrent) } : {}),
    problems,
  };
}

/** Does a backend's declared capacity cover what a stage asks for? */
export function fits(need: Resources | undefined, have: Resources | undefined): boolean {
  if (!need) return true;
  if (need.cpus && have?.cpus !== undefined && need.cpus > have.cpus) return false;
  if (need.memoryGb && have?.memoryGb !== undefined && need.memoryGb > have.memoryGb) return false;
  const labels = (have?.labels ?? []).map((l) => l.toLowerCase());
  return (need.labels ?? []).every((l) => labels.includes(l.toLowerCase()));
}
