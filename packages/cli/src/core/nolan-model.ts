/**
 * Nolan's model selection — pure decision logic.
 *
 * Nolan (chat mentor + autopilot reviewer) historically always adopted GG
 * Coder's model. Now each project can pin Nolan to his OWN model:
 *
 *   - No override set → Nolan follows EZ Coder's model (including live switches).
 *   - Override set    → Nolan uses it; EZ Coder model switches no longer touch him.
 *
 * The sidecar persists the override per project (ezcoder-app.json `nolanModels`) and
 * wires the live sessions; this module owns validation + resolution so both
 * are unit-testable without booting the sidecar.
 */
import type { Provider } from "@prestyj/ai";

/** A pinned Nolan model choice: provider + model id. */
export interface NolanModelPref {
  provider: Provider;
  model: string;
}

/**
 * Validate a persisted (or requested) override before applying it. A stale
 * entry — model gone from the registry, or its provider no longer connected —
 * silently resolves to null so Nolan falls back to following EZ Coder instead
 * of erroring on every turn.
 */
export function validateNolanModelPref(
  pref: NolanModelPref | null | undefined,
  opts: { modelExists: (id: string) => boolean; providerConnected: (p: Provider) => boolean },
): NolanModelPref | null {
  if (!pref || !pref.model || !pref.provider) return null;
  if (!opts.modelExists(pref.model)) return null;
  if (!opts.providerConnected(pref.provider)) return null;
  return pref;
}

/** What the footer needs to render `Nolan <model>`: the model Nolan will actually
 *  use next turn, plus whether that's a pin or just following EZ Coder. */
export interface EffectiveNolanModel {
  nolanProvider: Provider;
  nolanModel: string;
  /** True when a user-set override is active (not following EZ Coder). */
  nolanModelOverride: boolean;
}

/**
 * Resolve the model Nolan uses right now: the override when set, otherwise the
 * build session's current model.
 */
export function effectiveNolanModel(
  override: NolanModelPref | null,
  build: { provider: Provider; model: string },
): EffectiveNolanModel {
  if (override) {
    return { nolanProvider: override.provider, nolanModel: override.model, nolanModelOverride: true };
  }
  return { nolanProvider: build.provider, nolanModel: build.model, nolanModelOverride: false };
}
