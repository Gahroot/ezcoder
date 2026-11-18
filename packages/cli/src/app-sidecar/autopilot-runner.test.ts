import { describe, expect, it, vi } from "vitest";
import type { Message } from "@prestyj/ai";
import { createAutopilotRunner, type AutopilotRunnerContext } from "./autopilot-runner.js";
import type { AskUserPrompt } from "../core/ask-user.js";

const prompt: AskUserPrompt = {
  id: "ask-1",
  questions: [{ id: "go", question: "Add the test?", kind: "confirm" }],
};

// A Nolan session that replies from a script, one reply per prompt.
function harness(replies: string[]) {
  const mentor = {
    messages: [] as Message[],
    prompts: [] as string[],
    concurrent: 0,
    maxConcurrent: 0,
    async prompt(text: string) {
      this.prompts.push(text);
      this.concurrent += 1;
      this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      this.messages.push({ role: "assistant", content: replies.shift() ?? "" });
      this.concurrent -= 1;
    },
    getMessages() {
      return this.messages;
    },
  };
  const ctx = {
    autopilot: true,
    autopilotReviewing: false,
    autopilotCancelled: false,
    cwd: "/project",
    gitBranch: "main",
    injectedAutopilotPrompts: [] as string[],
    pendingNolanAutoModel: null as AutopilotRunnerContext["pendingNolanAutoModel"],
    pendingPlanPath: null,
    session: {
      getMessages: () => [{ role: "user", content: "add a regression test" }] as Message[],
      getVerificationEvidence: () => [],
      getVerificationProblem: () => null,
    },
    broadcast: vi.fn(),
    broadcastError: vi.fn(),
    ensureNolanAutoSession: async () => mentor,
    loadWorkflowCommandSpecs: async () => [],
    syncNolanAutoModel: vi.fn(async () => {}),
  };
  const runner = createAutopilotRunner(ctx as unknown as AutopilotRunnerContext);
  return { ctx, mentor, runner };
}

describe("answerAskWithNolan", () => {
  it("prompts Nolan with the question and parses his answer", async () => {
    const { ctx, mentor, runner } = harness(['ANSWER\n{"go":"yes"}']);
    const reviewing: boolean[] = [];
    ctx.ensureNolanAutoSession = async () => {
      reviewing.push(ctx.autopilotReviewing);
      return mentor;
    };
    expect(await runner.answerAskWithNolan(prompt, () => true)).toEqual({
      kind: "answer",
      answers: { go: "yes" },
    });
    expect(mentor.prompts[0]).toContain("## Question for you");
    expect(mentor.prompts[0]).toContain("add a regression test");
    expect(reviewing).toEqual([true]);
    expect(ctx.autopilotReviewing).toBe(false);
  });

  it("answers one card at a time and reviews wait for an answer in flight", async () => {
    const { ctx, mentor, runner } = harness([
      'ANSWER {"go":"yes"}',
      "HUMAN\nDestructive.",
      "ALL_CLEAR",
    ]);
    const second = { ...prompt, id: "ask-2" };
    const [a, b, review] = await Promise.all([
      runner.answerAskWithNolan(prompt, () => true),
      runner.answerAskWithNolan(second, () => true),
      runner.runAutopilotReview("add a regression test"),
    ]);
    expect(mentor.maxConcurrent).toBe(1);
    expect(a).toMatchObject({ kind: "answer" });
    expect(b).toEqual({ kind: "human", reason: "Destructive." });
    expect(review).toEqual({ kind: "all_clear" });
    expect(ctx.broadcastError).not.toHaveBeenCalled();
  });

  it("skips a card that is no longer pending and applies a model switch afterwards", async () => {
    const { ctx, mentor, runner } = harness(['ANSWER {"go":"no"}']);
    expect(await runner.answerAskWithNolan(prompt, () => false)).toBeNull();
    expect(mentor.prompts).toHaveLength(0);

    ctx.ensureNolanAutoSession = async () => {
      ctx.pendingNolanAutoModel = { provider: "anthropic", model: "m" };
      return mentor;
    };
    await runner.answerAskWithNolan(prompt, () => true);
    expect(ctx.syncNolanAutoModel).toHaveBeenCalledWith("anthropic", "m");
  });
});
