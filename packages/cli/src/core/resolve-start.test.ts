import { describe, it, expect } from "vitest";
import type { Provider } from "@prestyj/ai";
import { getDefaultModel } from "./model-registry.js";
import { resolveStartOrFallback, type ProviderAuthLookup } from "./resolve-start.js";

const ALL: Provider[] = [
  "anthropic",
  "xiaomi",
  "openai",
  "gemini",
  "glm",
  "moonshot",
  "minimax",
  "deepseek",
  "openrouter",
  "sakana",
  "xai",
];

/** Fake auth lookup: only the providers in `set` are "logged in". */
function auth(...connected: Provider[]): ProviderAuthLookup {
  return authKeys(connected);
}

/** Fake auth lookup with explicit storage keys (e.g. Xiaomi Token Plan only). */
function authKeys(connected: Provider[], storageKeys: string[] = connected): ProviderAuthLookup {
  const providers = new Set<string>(connected);
  const keys = new Set(storageKeys);
  return {
    hasProviderAuth: async (p) => providers.has(p),
    pickStorageKey: async (wanted) => wanted.find((k) => keys.has(k)),
  };
}

describe("resolveStartOrFallback", () => {
  it("falls back to preferred + default model when no provider is logged in", async () => {
    const res = await resolveStartOrFallback(auth(), ALL, "anthropic", undefined);
    expect(res.loggedIn).toBe(false);
    expect(res.provider).toBe("anthropic");
    expect(res.model).toBe(getDefaultModel("anthropic").id);
  });

  it("honors a non-anthropic preferred provider in the logged-out fallback", async () => {
    const res = await resolveStartOrFallback(auth(), ALL, "openai", undefined);
    expect(res.loggedIn).toBe(false);
    expect(res.provider).toBe("openai");
    expect(res.model).toBe(getDefaultModel("openai").id);
  });

  it("uses the preferred provider's default model when logged in with no saved model", async () => {
    const res = await resolveStartOrFallback(auth("anthropic"), ALL, "anthropic", undefined);
    expect(res.loggedIn).toBe(true);
    expect(res.provider).toBe("anthropic");
    expect(res.model).toBe(getDefaultModel("anthropic").id);
  });

  it("keeps a saved model that belongs to the preferred provider", async () => {
    const saved = getDefaultModel("anthropic").id;
    const res = await resolveStartOrFallback(auth("anthropic"), ALL, "anthropic", saved);
    expect(res.loggedIn).toBe(true);
    expect(res.provider).toBe("anthropic");
    expect(res.model).toBe(saved);
  });

  it("ignores a saved model that belongs to a different provider", async () => {
    // Saved model is an OpenAI model but preferred is anthropic → default anthropic.
    const otherProviderModel = getDefaultModel("openai").id;
    const res = await resolveStartOrFallback(
      auth("anthropic"),
      ALL,
      "anthropic",
      otherProviderModel,
    );
    expect(res.provider).toBe("anthropic");
    expect(res.model).toBe(getDefaultModel("anthropic").id);
  });

  it("falls back to the first logged-in provider when preferred is not connected", async () => {
    // Preferred anthropic is logged out; only openai is connected.
    const res = await resolveStartOrFallback(auth("openai"), ALL, "anthropic", undefined);
    expect(res.loggedIn).toBe(true);
    expect(res.provider).toBe("openai");
    expect(res.model).toBe(getDefaultModel("openai").id);
  });

  it("picks the first connected provider in registry order", async () => {
    // Both gemini and glm connected; ALL lists gemini before glm.
    const res = await resolveStartOrFallback(auth("glm", "gemini"), ALL, "anthropic", undefined);
    expect(res.provider).toBe("gemini");
  });

  it("drops a saved model whose credential is missing (Xiaomi Token Plan + Ultra Speed)", async () => {
    // Ultra Speed needs API Credits; only the Token Plan is connected. Booting
    // with it locked the project with "Not logged in to xiaomi".
    const res = await resolveStartOrFallback(
      authKeys(["xiaomi", "openai"], ["xiaomi", "openai"]),
      ALL,
      "xiaomi",
      "mimo-v2.6-pro-ultraspeed",
    );
    expect(res.loggedIn).toBe(true);
    expect(res.provider).toBe("xiaomi");
    expect(res.model).toBe(getDefaultModel("xiaomi").id);
  });

  it("keeps Ultra Speed when API Credits are connected", async () => {
    const res = await resolveStartOrFallback(
      authKeys(["xiaomi"], ["xiaomi-credits"]),
      ALL,
      "xiaomi",
      "mimo-v2.6-pro-ultraspeed",
    );
    expect(res.model).toBe("mimo-v2.6-pro-ultraspeed");
  });
});
