// User-level cloud settings (~/.ezcoder/cloud.json) and runtime state
// (~/.ezcoder/cloud/state.json). Zero config by default: every provider the
// user is signed in to is used automatically, as overflow capacity only.
import fs from "node:fs";
import path from "node:path";
import { getAppPaths } from "@prestyj/core";
import type { CloudProviderId } from "./types.js";

export type CloudUse = "validation" | "jobs" | "agents";

export interface CloudProviderSettings {
  /** false turns this provider off (default: on when signed in). */
  enabled?: boolean;
  /** Max tasks at once on this provider (default 3). */
  maxConcurrent?: number;
  /** Model for runner/validation tasks (cheapest capable by default). */
  runnerModel?: string;
  /** Environment to use (Claude env_…, Codex environment id); auto when absent. */
  environment?: string;
}

export interface CloudSettings {
  /** false turns cloud off entirely. */
  enabled?: boolean;
  /**
   * When cloud gets work:
   * - "overflow" (default): only when no self-hosted machine has room (busy, full or offline)
   * - "always": as one more machine, by load
   * - "manual": only when a stage/job/agent names it
   */
  when?: "overflow" | "always" | "manual";
  /** What cloud may run (default: all three). */
  use?: CloudUse[];
  /** Stop sending work when weekly plan utilization passes this (0-1, default 0.8). */
  maxPlanUtilization?: number;
  providers?: Partial<Record<CloudProviderId, CloudProviderSettings>>;
  /**
   * Which provider gets work first when several can take it (default: Codex,
   * then Claude, to save the Claude plan for interactive coding). Validation
   * and jobs still only go to providers whose results can be verified.
   */
  order?: CloudProviderId[];
}

/** Default preference: Codex first, saving the Claude plan for coding. */
export const DEFAULT_CLOUD_ORDER: readonly CloudProviderId[] = ["codex-cloud", "claude-cloud"];

/** Provider ids in preference order: the user's order, then any left out. */
export function providerOrder(settings: CloudSettings): CloudProviderId[] {
  const out: CloudProviderId[] = [];
  for (const id of [...(settings.order ?? []), ...DEFAULT_CLOUD_ORDER]) {
    if (DEFAULT_CLOUD_ORDER.includes(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

export const DEFAULT_CLOUD_MAX_CONCURRENT = 3;
export const DEFAULT_MAX_PLAN_UTILIZATION = 0.8;

export function cloudDir(): string {
  return path.join(getAppPaths().agentDir, "cloud");
}

export function cloudSettingsFile(): string {
  return path.join(getAppPaths().agentDir, "cloud.json");
}

export function readCloudSettings(file = cloudSettingsFile()): CloudSettings {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as CloudSettings;
  } catch {
    return {};
  }
}

/** Save the settings atomically (temp file + rename). */
export function writeCloudSettings(settings: CloudSettings, file = cloudSettingsFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function cloudAllowedFor(settings: CloudSettings, use: CloudUse): boolean {
  if (settings.enabled === false) return false;
  return (settings.use ?? ["validation", "jobs", "agents"]).includes(use);
}

export function providerSettings(
  settings: CloudSettings,
  id: CloudProviderId,
): CloudProviderSettings & { maxConcurrent: number } {
  const p = settings.providers?.[id] ?? {};
  return { ...p, maxConcurrent: Math.max(1, p.maxConcurrent ?? DEFAULT_CLOUD_MAX_CONCURRENT) };
}

/** Runtime state that must survive restarts (benches after usage limits). */
export interface CloudState {
  /** Provider benched until (ISO), with the reason. */
  benched?: Partial<Record<CloudProviderId, { until: string; reason: string }>>;
  /** Last plan utilization seen per provider (0-1) and when. */
  utilization?: Partial<Record<CloudProviderId, { value: number; at: string; resetsAt?: string }>>;
}

function stateFile(): string {
  return path.join(cloudDir(), "state.json");
}

export function readCloudState(): CloudState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8")) as CloudState;
  } catch {
    return {};
  }
}

export function updateCloudState(update: (s: CloudState) => CloudState): CloudState {
  const next = update(readCloudState());
  fs.mkdirSync(cloudDir(), { recursive: true });
  const tmp = `${stateFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  fs.renameSync(tmp, stateFile());
  return next;
}

/** Bench a provider (usage limit hit) until `until`. */
export function benchProvider(id: CloudProviderId, until: string, reason: string): void {
  updateCloudState((s) => ({ ...s, benched: { ...s.benched, [id]: { until, reason } } }));
}

export function benchedUntil(id: CloudProviderId, now = Date.now()): string | undefined {
  const b = readCloudState().benched?.[id];
  return b && Date.parse(b.until) > now ? b.until : undefined;
}

export function recordUtilization(id: CloudProviderId, value: number, resetsAt?: string): void {
  updateCloudState((s) => ({
    ...s,
    utilization: {
      ...s.utilization,
      [id]: { value, at: new Date().toISOString(), ...(resetsAt && { resetsAt }) },
    },
  }));
}
