import { describe, expect, it } from "vitest";
import {
  VerificationGate,
  isCodeFilePath,
  isVerificationCommand,
  MAX_VERIFICATION_INJECTIONS,
} from "./verification-gate.js";

describe("isVerificationCommand", () => {
  const yes = [
    ["npm test", "npm test"],
    ["pnpm test:unit", "script name with test: prefix"],
    ["yarn run build", "yarn run build"],
    ["npx vitest run src", "npx vitest"],
    ["vitest run", "bare vitest"],
    ["jest --coverage", "bare jest"],
    ["tsc --noEmit", "bare tsc"],
    ["eslint src/", "bare eslint"],
    ["go test ./...", "go test"],
    ["cargo test", "cargo test"],
    ["cargo clippy", "cargo clippy"],
    ["make check", "make check"],
    ["python -m pytest -x", "python -m pytest"],
    ["pytest tests/", "bare pytest"],
    ["uv run pytest", "uv run pytest"],
    ["timeout 30s npm test", "timeout wrapper with duration"],
    ["CI=1 npm test", "env-var wrapper"],
    ["ruff check src", "ruff check"],
    ["biome check .", "biome check"],
    ["gradle test", "gradle test"],
    ["dotnet test", "dotnet test"],
    ["deno task test", "deno task test"],
  ];
  const no = [
    ["git commit -m fix test", "commit message mentioning test"],
    ["grep test file.ts", "grep for the word test"],
    ["cat test-output.log", "cat a log"],
    ["./run_tests.sh", "direct script"],
    ["bash scripts/test.sh", "bash-invoked script"],
    ["npm install", "package install"],
    ["npm run dev", "dev server"],
    ["go run main.go", "go run"],
    ["python train.py", "python script"],
    ["echo running tests soon", "echo mentioning tests"],
  ];

  it.each(yes)("classifies %s as verification (%s)", (command) => {
    expect(isVerificationCommand(command)).toBe(true);
  });
  it.each(no)("classifies %s as NOT verification (%s)", (command) => {
    expect(isVerificationCommand(command)).toBe(false);
  });
});

describe("isCodeFilePath", () => {
  it("accepts source files", () => {
    expect(isCodeFilePath("src/a.ts")).toBe(true);
    expect(isCodeFilePath("src/a.test.tsx")).toBe(true);
    expect(isCodeFilePath("lib/x.py")).toBe(true);
    expect(isCodeFilePath("src/main.rs")).toBe(true);
    expect(isCodeFilePath("cmd/tool.go")).toBe(true);
  });
  it("rejects non-code files", () => {
    expect(isCodeFilePath("README.md")).toBe(false);
    expect(isCodeFilePath("package.json")).toBe(false);
    expect(isCodeFilePath("logo.svg")).toBe(false);
    expect(isCodeFilePath("notes.txt")).toBe(false);
  });
});

describe("VerificationGate", () => {
  it("is silent with no mutations", () => {
    const gate = new VerificationGate();
    gate.recordVerification();
    expect(gate.isOwed()).toBe(false);
    expect(gate.followUp()).toBeNull();
  });

  it("is owed after a mutation until a verification follows", () => {
    const gate = new VerificationGate();
    gate.recordVerification();
    gate.recordMutation("a.ts");
    expect(gate.isOwed()).toBe(true);
    const followUp = gate.followUp()!;
    expect(followUp).toHaveLength(1);
    expect(String(followUp[0]!.content)).toContain("a.ts");
    gate.recordVerification();
    expect(gate.isOwed()).toBe(false);
    expect(gate.followUp()).toBeNull();
  });

  it("demands once, escalates once, then goes silent", () => {
    const gate = new VerificationGate();
    gate.recordMutation("a.ts");

    const demand = gate.followUp()!;
    expect(String(demand[0]!.content)).toContain("Run the project's verification");

    // Model stopped again without verifying.
    const escalation = gate.followUp()!;
    expect(String(escalation[0]!.content)).toContain("unverified");

    expect(gate.followUp()).toBeNull();
    expect(MAX_VERIFICATION_INJECTIONS).toBe(1);
  });

  it("a later mutation re-arms an already-satisfied gate after a fresh budget reset", () => {
    const gate = new VerificationGate();
    gate.recordMutation("a.ts");
    gate.followUp();
    gate.recordVerification();
    expect(gate.followUp()).toBeNull();
    gate.reset();
    expect(gate.isOwed()).toBe(false);
  });
});
