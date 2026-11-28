// The cloud providers EZ Coder can use. Auto-managed: a provider is available
// when the user is signed in to it in EZ Coder (Claude subscription / ChatGPT
// sign-in), it isn't turned off, it isn't benched after a usage limit, and its
// plan utilization is under the cap. Callers never name providers they don't
// need: validation, fleet jobs and agents all ask here.
import {
  benchedUntil,
  cloudAllowedFor,
  DEFAULT_MAX_PLAN_UTILIZATION,
  providerOrder,
  providerSettings,
  readCloudSettings,
  readCloudState,
  type CloudSettings,
  type CloudUse,
} from "./config.js";
import { ClaudeCloudProvider } from "./claude.js";
import { CodexCloudProvider } from "./codex.js";
import {
  CLOUD_LABELS,
  type CloudAvailability,
  type CloudProvider,
  type CloudProviderId,
} from "./types.js";

let cached: Map<CloudProviderId, CloudProvider> | undefined;

/** Overridable for tests. */
export function setCloudProvidersForTest(providers: CloudProvider[] | undefined): void {
  cached = providers ? new Map(providers.map((p) => [p.id, p])) : undefined;
}

export function cloudProvider(id: CloudProviderId): CloudProvider {
  cached ??= new Map<CloudProviderId, CloudProvider>([
    ["claude-cloud", new ClaudeCloudProvider()],
    ["codex-cloud", new CodexCloudProvider()],
  ]);
  return cached.get(id)!;
}

/**
 * Every provider with its availability for `use` (and project), in
 * preference order (`order` in cloud.json; Codex first by default). Never throws: problems become `detail`.
 */
export async function cloudAvailability(
  use: CloudUse,
  project?: { repoRoot?: string; repo?: string },
  settings: CloudSettings = readCloudSettings(),
): Promise<CloudAvailability[]> {
  const allowed = cloudAllowedFor(settings, use);
  const cap = settings.maxPlanUtilization ?? DEFAULT_MAX_PLAN_UTILIZATION;
  const state = readCloudState();
  return Promise.all(
    providerOrder(settings).map(async (id): Promise<CloudAvailability> => {
      if (!allowed) {
        return { id, available: false, detail: `cloud is off for ${use} (~/.ezcoder/cloud.json)` };
      }
      if (providerSettings(settings, id).enabled === false) {
        return { id, available: false, detail: `${CLOUD_LABELS[id]} is turned off` };
      }
      const until = benchedUntil(id);
      if (until) {
        const reason = state.benched?.[id]?.reason ?? "usage limit";
        return {
          id,
          available: false,
          limitedUntil: until,
          detail: `${reason}; paused until ${new Date(until).toLocaleString()}`,
        };
      }
      const util = state.utilization?.[id];
      if (util && util.value >= cap && (!util.resetsAt || Date.parse(util.resetsAt) > Date.now())) {
        return {
          id,
          available: false,
          ...(util.resetsAt && { limitedUntil: util.resetsAt }),
          detail: `plan ${Math.round(util.value * 100)}% used (cap ${Math.round(cap * 100)}%), saving the rest for you`,
        };
      }
      try {
        return await cloudProvider(id).detect(project);
      } catch (e) {
        return { id, available: false, detail: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
}
