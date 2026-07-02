import { describe, it, expect } from "vitest";
import { buildNolanSystemPrompt, buildNolanAutopilotSystemPrompt } from "./nolan-prompt.js";
import { INJECTED_PROMPT_LABEL } from "./nolan-context.js";

describe("buildNolanAutopilotSystemPrompt — verdict contract", () => {
  const prompt = buildNolanAutopilotSystemPrompt();

  it("teaches all four verdict keywords", () => {
    for (const keyword of ["PROMPT", "ALL_CLEAR", "IGNORE", "HUMAN"]) {
      expect(prompt).toContain(keyword);
    }
  });

  it("routes end-of-turn questions/options/plans to HUMAN, never PROMPT", () => {
    // Leak regression: without this rule, EZ Coder ending with "want me to…?"
    // or an A/B/C menu reads as "unfinished" and Nolan answers for the user.
    expect(prompt).toContain("asking the ");
    expect(prompt).toContain("presenting options");
    expect(prompt).toContain("never answer on the user's behalf");
    expect(prompt).toContain("submitting a plan for approval");
  });

  it("tells Nolan injected transcript lines are his own, not user asks", () => {
    expect(prompt).toContain("Nolan autopilot (injected)");
    expect(prompt).toContain("Judge only against the original user request");
  });

  it("anchors ALL_CLEAR judgment to the pinned Original user request section", () => {
    expect(prompt).toContain("Original ");
    expect(prompt).toContain("user request' section");
    expect(prompt).toContain("never a later injected prompt");
  });

  it("keeps the injected label byte-identical to the digest renderer's", () => {
    // The system prompt names the label in prose; the digest emits it. If the
    // label constant drifts, the prompt's rule points at nothing.
    expect(INJECTED_PROMPT_LABEL).toContain("Nolan autopilot (injected)");
    expect(prompt).toContain("Nolan autopilot (injected)");
  });
});

describe("buildNolanSystemPrompt — chat mode unaffected", () => {
  it("keeps the chat output contract (prompt fence) and no verdict keywords", () => {
    const prompt = buildNolanSystemPrompt();
    expect(prompt).toContain("Send to EZ Coder");
    // The verdict contract is autopilot-only.
    expect(prompt).not.toContain("ALL_CLEAR");
  });
});
