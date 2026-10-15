import type { Provider } from "@prestyj/ai";
import { getDefaultModel, getModel, type ModelInfo } from "./model-registry.js";

/** A resolved startup provider + model for an AgentSession. */
export interface ResolvedStart {
  provider: Provider;
  model: string;
}

/** The boot-time provider resolution, plus whether the user is logged in. */
export interface ResolvedStartResult extends ResolvedStart {
  /** False when no provider has usable credentials — the sidecar boots anyway
   *  (logged-out, login endpoints reachable) instead of crashing. */
  loggedIn: boolean;
}

/** Minimal auth surface needed to decide the startup provider (testable). */
export interface ProviderAuthLookup {
  hasProviderAuth(provider: string): Promise<boolean>;
  /** First of `keys` with a stored credential (see AuthStorage.pickStorageKey). */
  pickStorageKey(keys: string[]): Promise<string | undefined>;
}

/**
 * True when `model` can actually authenticate. Provider-level auth isn't enough
 * for models pinned to specific credentials (`authStorageKeys`): Xiaomi's
 * `mimo-v2.6-pro-ultraspeed` needs API Credits even when the Token Plan is
 * connected, and OAuth-only Kimi models need the Kimi sign-in, not the API key.
 */
async function modelHasAuth(auth: ProviderAuthLookup, model: ModelInfo): Promise<boolean> {
  if (!model.authStorageKeys) return true;
  return (await auth.pickStorageKey(model.authStorageKeys)) !== undefined;
}

/** The provider's default model, when this login can actually use it. */
async function usableDefault(
  auth: ProviderAuthLookup,
  provider: Provider,
): Promise<string | undefined> {
  const model = getDefaultModel(provider);
  return (await modelHasAuth(auth, model)) ? model.id : undefined;
}

/**
 * Pick a provider/model the user is logged into, preferring the saved defaults.
 * Mirrors the CLI's resolveActiveProvider, but NEVER throws when logged out:
 * instead it falls back to `preferred` + its default model and reports
 * `loggedIn: false`. This is what lets the ezcoder-app sidecar boot (and serve the
 * login endpoints) for a fresh user with no credentials — throwing here used to
 * kill the sidecar before it listened, making login impossible.
 *
 * Credentials resolve lazily at prompt time, so a logged-out boot is safe: a
 * prompt sent before login fails cleanly through the run's error handling.
 */
export async function resolveStartOrFallback(
  auth: ProviderAuthLookup,
  allProviders: readonly Provider[],
  preferred: Provider,
  savedModel: string | undefined,
): Promise<ResolvedStartResult> {
  const loggedIn: Provider[] = [];
  for (const p of allProviders) {
    if (await auth.hasProviderAuth(p)) loggedIn.push(p);
  }

  if (loggedIn.length === 0) {
    // Logged-out fallback: boot with the preferred provider's default model so
    // the sidecar still starts and the login flow is reachable.
    return { provider: preferred, model: getDefaultModel(preferred).id, loggedIn: false };
  }

  if (loggedIn.includes(preferred)) {
    // A saved model this login can't authenticate (e.g. picked, then backed out
    // of, a model needing a credential the user never configured) must not lock
    // the project: fall back to the provider default, then to another provider.
    const saved = savedModel ? getModel(savedModel) : undefined;
    if (saved?.provider === preferred && (await modelHasAuth(auth, saved))) {
      return { provider: preferred, model: saved.id, loggedIn: true };
    }
    const model = await usableDefault(auth, preferred);
    if (model) return { provider: preferred, model, loggedIn: true };
  }

  for (const provider of loggedIn) {
    if (provider === preferred) continue;
    const model = await usableDefault(auth, provider);
    if (model) return { provider, model, loggedIn: true };
  }

  // Every logged-in provider's default needs a credential that's missing —
  // keep the old behaviour rather than claiming the user is logged out.
  const provider = loggedIn[0]!;
  return { provider, model: getDefaultModel(provider).id, loggedIn: true };
}
