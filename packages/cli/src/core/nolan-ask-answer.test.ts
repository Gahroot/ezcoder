import { describe, expect, it } from "vitest";
import { parseNolanAskAnswer } from "./nolan-ask-answer.js";
import type { AskQuestion } from "./ask-user.js";

const choice: AskQuestion = {
  id: "store",
  question: "Where should sessions live?",
  kind: "choice",
  options: [
    { label: "SQLite", value: "sqlite" },
    { label: "JSON files", value: "json" },
  ],
  allowOther: false,
};
const confirm: AskQuestion = { id: "go", question: "Add the test?", kind: "confirm" };
const multi: AskQuestion = {
  id: "targets",
  question: "Which platforms?",
  kind: "multi",
  options: [{ label: "macOS" }, { label: "Linux" }, { label: "Windows" }],
  allowOther: false,
};
const text: AskQuestion = { id: "name", question: "Name the flag?", kind: "text" };

describe("parseNolanAskAnswer", () => {
  it("accepts a valid answer for every question kind", () => {
    const reply =
      'ANSWER\n{"store":"sqlite","go":"yes","targets":["macOS","Linux"],"name":"fastPath"}';
    expect(parseNolanAskAnswer(reply, [choice, confirm, multi, text])).toEqual({
      kind: "answer",
      answers: { store: "sqlite", go: "yes", targets: ["macOS", "Linux"], name: "fastPath" },
    });
  });

  it("maps labels to option values and defaults confirm to yes/no", () => {
    const reply = 'ANSWER\n```json\n{"store":"JSON files","go":"No"}\n```';
    expect(parseNolanAskAnswer(reply, [choice, confirm])).toEqual({
      kind: "answer",
      answers: { store: "json", go: "no" },
    });
  });

  it("takes free text only where the question allows it", () => {
    const open: AskQuestion = { ...choice, allowOther: undefined };
    expect(parseNolanAskAnswer('ANSWER {"store":"Postgres"}', [open])).toEqual({
      kind: "answer",
      answers: { store: "Postgres" },
    });
    expect(parseNolanAskAnswer('ANSWER {"store":"Postgres"}', [choice])).toMatchObject({
      kind: "human",
    });
  });

  it("falls back to HUMAN on missing, invalid or malformed answers", () => {
    expect(parseNolanAskAnswer('ANSWER\n{"go":"yes"}', [choice, confirm]).kind).toBe("human");
    expect(parseNolanAskAnswer('ANSWER\n{"targets":["BeOS"]}', [multi]).kind).toBe("human");
    expect(parseNolanAskAnswer('ANSWER\n{"targets":[]}', [multi]).kind).toBe("human");
    expect(parseNolanAskAnswer('ANSWER\n{"name":"  "}', [text]).kind).toBe("human");
    expect(parseNolanAskAnswer("ANSWER\n{store: sqlite", [choice]).kind).toBe("human");
    expect(parseNolanAskAnswer('ANSWER\n["sqlite"]', [choice]).kind).toBe("human");
    expect(parseNolanAskAnswer('I think sqlite.\nANSWER {"store":"sqlite"}', [choice]).kind).toBe(
      "human",
    );
    expect(parseNolanAskAnswer("", [choice]).kind).toBe("human");
  });

  it("carries the reason on HUMAN", () => {
    expect(parseNolanAskAnswer("HUMAN\nThis drops the prod table.", [confirm])).toEqual({
      kind: "human",
      reason: "This drops the prod table.",
    });
    expect(parseNolanAskAnswer("HUMAN: pricing is the user's call", [confirm])).toEqual({
      kind: "human",
      reason: "pricing is the user's call",
    });
    expect(parseNolanAskAnswer("HUMAN", [confirm]).kind).toBe("human");
  });
});
