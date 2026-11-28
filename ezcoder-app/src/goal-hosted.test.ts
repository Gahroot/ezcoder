import { describe, expect, it } from "vitest";
import { hostedGoalLine, hostedGoalText } from "./goal-hosted";

describe("hosted goal lines", () => {
  it("says where the run is and how it stands", () => {
    expect(hostedGoalText({ node: "groot-pc", state: "running" })).toBe("Running on groot-pc");
    expect(hostedGoalText({ node: "groot-pc", state: "preparing" })).toBe(
      "Getting ready on groot-pc",
    );
    expect(
      hostedGoalText({
        node: "groot-pc",
        state: "done",
        resultBranch: "ezcoder/goal/g-1",
        resultSha: "abcdef1234567",
      }),
    ).toBe("Done on groot-pc, result on branch ezcoder/goal/g-1 (abcdef1)");
    expect(hostedGoalText({ node: "groot-pc", state: "done" })).toBe("Done on groot-pc");
    expect(hostedGoalText({ node: "groot-pc", state: "unreachable" })).toBe(
      "Can't reach groot-pc right now",
    );
  });

  it("adds the last check's problem", () => {
    expect(hostedGoalLine({ node: "groot-pc", state: "running", error: "timed out" })).toBe(
      "Running on groot-pc. Last check failed: timed out",
    );
  });
});
