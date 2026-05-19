import { describe, expect, it } from "vitest";
import { normalizePromptCacheKey } from "./prompt-cache-key.js";

describe("normalizePromptCacheKey", () => {
  it("leaves valid cache keys unchanged", () => {
    expect(normalizePromptCacheKey("ezboss:short-session-id")).toBe("ezboss:short-session-id");
  });

  it("clamps long cache keys to OpenAI's 64 character limit", () => {
    const longKey = `ezboss-worker:linktree-harmony:${"a".repeat(36)}`;
    const normalized = normalizePromptCacheKey(longKey);

    expect(longKey.length).toBeGreaterThan(64);
    expect(normalized.length).toBeLessThanOrEqual(64);
    expect(normalized).toMatch(/^ezboss-worker:linktree-harmony:.*:[0-9a-f]{8}$/);
  });

  it("keeps different long keys distinct", () => {
    const first = normalizePromptCacheKey(`ezboss-worker:linktree-harmony:${"a".repeat(36)}`);
    const second = normalizePromptCacheKey(`ezboss-worker:linktree-harmony:${"b".repeat(36)}`);

    expect(first).not.toBe(second);
  });
});
