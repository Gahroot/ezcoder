import { describe, expect, it } from "vitest";
import { describeRunVerification } from "./run-status.js";
import { VerificationGate } from "./verification-gate.js";

describe("desktop verification evidence", () => {
  it("never equates no evidence with a passing check", () => {
    expect(describeRunVerification([], null)).toEqual({
      verification: "not_recorded",
      verifiedChecks: 0,
    });
    expect(describeRunVerification([], "Verification owed").verification).toBe("incomplete");
  });
  it("uses current-revision successes and rejects stale passes", () => {
    const gate = new VerificationGate();
    gate.recordMutation("src/example.ts");
    gate.recordVerification(gate.revision, "pnpm test");
    expect(describeRunVerification(gate.evidence(), gate.verificationProblem())).toEqual({
      verification: "passed",
      verifiedChecks: 1,
    });
    gate.recordMutation("src/example.ts");
    expect(describeRunVerification(gate.evidence(), gate.verificationProblem())).toEqual({
      verification: "incomplete",
      verifiedChecks: 0,
    });
  });
  it("a failure is not hidden by another passing command", () => {
    const gate = new VerificationGate();
    gate.recordMutation("src/example.ts");
    gate.recordFailedVerification("pnpm test");
    gate.recordVerification(gate.revision, "pnpm build");
    expect(describeRunVerification(gate.evidence(), gate.verificationProblem()).verification).toBe(
      "failed",
    );
  });
  it("an unresolved integrity gate is not green even with passing tests", () => {
    expect(
      describeRunVerification(
        [{ command: "pnpm test", status: "passed", reason: "Exit 0" }],
        "Review test changes",
      ).verification,
    ).toBe("incomplete");
  });
});
