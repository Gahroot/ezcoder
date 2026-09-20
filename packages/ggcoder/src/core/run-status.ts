import type { VerificationEvidence } from "./verification-evidence.js";

/** Host-observed verification for the desktop, never inferred from assistant text. */
export function describeRunVerification(
  evidence: readonly VerificationEvidence[],
  problem: string | null,
): {
  verification: "passed" | "failed" | "incomplete" | "not_recorded";
  verifiedChecks: number;
} {
  const verifiedChecks = evidence.filter((entry) => entry.status === "passed").length;
  return {
    verification: evidence.some((entry) => entry.status === "failed")
      ? "failed"
      : problem
        ? "incomplete"
        : verifiedChecks > 0
          ? "passed"
          : "not_recorded",
    verifiedChecks,
  };
}
