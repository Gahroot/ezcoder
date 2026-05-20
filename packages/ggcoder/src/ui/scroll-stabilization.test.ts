import { describe, expect, it } from "vitest";
import { getScrollStabilizationDecision } from "./App.js";

describe("getScrollStabilizationDecision", () => {
  it("preserves Static and disables auto-follow when the user is intentionally scrolled and output arrives", () => {
    expect(
      getScrollStabilizationDecision({
        isUserScrolled: true,
        hasNewOutput: true,
      }),
    ).toEqual({ preserveStatic: true, autoFollow: false });
  });

  it("keeps normal auto-follow behavior at the bottom for large inputs, queued messages, and live updates", () => {
    expect(
      getScrollStabilizationDecision({
        isUserScrolled: false,
        hasNewOutput: true,
      }),
    ).toEqual({ preserveStatic: false, autoFollow: true });
  });

  it("does not request stabilization when no new output is rendered", () => {
    expect(
      getScrollStabilizationDecision({
        isUserScrolled: true,
        hasNewOutput: false,
      }),
    ).toEqual({ preserveStatic: false, autoFollow: false });
  });
});
