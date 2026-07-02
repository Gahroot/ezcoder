import { describe, it, expect } from "vitest";
import { validateNolanModelPref, effectiveNolanModel, type NolanModelPref } from "./nolan-model.js";

const REGISTRY = new Set(["claude-opus-5", "gpt-5.5", "kimi-k2.7-code"]);
const CONNECTED = new Set(["anthropic", "openai"]);

const opts = {
  modelExists: (id: string) => REGISTRY.has(id),
  providerConnected: (p: string) => CONNECTED.has(p),
};

describe("validateNolanModelPref", () => {
  it("passes a valid pref through", () => {
    const pref: NolanModelPref = { provider: "openai", model: "gpt-5.5" };
    expect(validateNolanModelPref(pref, opts)).toEqual(pref);
  });

  it("nulls when the model left the registry (stale persisted pin)", () => {
    expect(validateNolanModelPref({ provider: "openai", model: "gpt-4-turbo" }, opts)).toBeNull();
  });

  it("nulls when the provider is no longer connected (logged out)", () => {
    expect(
      validateNolanModelPref({ provider: "moonshot", model: "kimi-k2.7-code" }, opts),
    ).toBeNull();
  });

  it("nulls absent / malformed prefs", () => {
    expect(validateNolanModelPref(null, opts)).toBeNull();
    expect(validateNolanModelPref(undefined, opts)).toBeNull();
    expect(validateNolanModelPref({ provider: "openai", model: "" }, opts)).toBeNull();
    expect(
      validateNolanModelPref({ provider: "" as NolanModelPref["provider"], model: "gpt-5.5" }, opts),
    ).toBeNull();
  });
});

describe("effectiveNolanModel", () => {
  const build = { provider: "anthropic" as const, model: "claude-opus-5" };

  it("follows the build session when no override is set", () => {
    expect(effectiveNolanModel(null, build)).toEqual({
      nolanProvider: "anthropic",
      nolanModel: "claude-opus-5",
      nolanModelOverride: false,
    });
  });

  it("uses the pin when set, ignoring the build model", () => {
    expect(effectiveNolanModel({ provider: "openai", model: "gpt-5.5" }, build)).toEqual({
      nolanProvider: "openai",
      nolanModel: "gpt-5.5",
      nolanModelOverride: true,
    });
  });

  it("pin identical to the build model still reports override=true (it survives GG switches)", () => {
    expect(effectiveNolanModel({ provider: "anthropic", model: "claude-opus-5" }, build)).toEqual({
      nolanProvider: "anthropic",
      nolanModel: "claude-opus-5",
      nolanModelOverride: true,
    });
  });
});
