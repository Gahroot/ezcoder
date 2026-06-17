import { describe, expect, it } from "vitest";
import { PROMPT_COMMANDS } from "./prompt-commands.js";

describe("prompt commands", () => {
  it("defines the /goal command for durable Goal setup", () => {
    const goal = PROMPT_COMMANDS.find((command) => command.name === "goal");

    expect(goal).toBeDefined();
    expect(goal?.aliases).toContain("g");
    expect(goal?.prompt).toContain("Create a Goal run");
    expect(goal?.prompt).toContain("durable Goal state");
  });

  it("hands setup/bullet-proof fixes off to the tasks tool, not a Goal", () => {
    const setup = PROMPT_COMMANDS.find((command) => command.name === "setup");
    const bulletProof = PROMPT_COMMANDS.find((command) => command.name === "bullet-proof");

    expect(setup?.prompt).toContain("`tasks` tool");
    expect(setup?.prompt).toContain("Press Ctrl+T to open the task list");
    expect(setup?.prompt).not.toContain("Create a Goal");
    expect(setup?.prompt).not.toContain("Press CTRL + G");
    expect(bulletProof?.prompt).toContain("`tasks` tool");
    expect(bulletProof?.prompt).toContain("Press Ctrl+T to open the task list");
    expect(bulletProof?.prompt).not.toContain("Create a Goal");
    expect(bulletProof?.prompt).not.toContain("Press CTRL + G");
  });

  it("removes retired prompt-template commands", () => {
    const removedCommandNames = [
      "scan",
      "verify",
      "source",
      "simplify",
      "batch",
      "research",
      "setup-lint",
      `setup-${"tests"}`,
      "setup-update",
    ];
    const removedAliases = ["depcheck", "depsource"];

    for (const name of removedCommandNames) {
      expect(PROMPT_COMMANDS.find((command) => command.name === name)).toBeUndefined();
    }
    for (const alias of removedAliases) {
      expect(PROMPT_COMMANDS.find((command) => command.aliases.includes(alias))).toBeUndefined();
    }
  });

  it("defines /expand as a fresh, repo-validated, feature-first plan-mode command", () => {
    const expand = PROMPT_COMMANDS.find((command) => command.name === "expand");

    expect(expand).toBeDefined();
    expect(expand?.prompt).toContain("Spawn exactly 5 sub-agents in parallel");
    expect(expand?.prompt).toContain("updated within the last 6 months");
    expect(expand?.prompt).toContain("validate it yourself before reporting");
    expect(expand?.prompt).toContain("The table must have exactly 3 columns");
    expect(expand?.prompt).toContain("Do not start implementing until the user chooses");
    expect(expand?.prompt).toContain("A) Build all of these features in plan mode");
    expect(expand?.prompt).toContain("B) Build only the top priority ones in plan mode");
    expect(expand?.prompt).toContain("C) Other");
    expect(expand?.prompt).toContain("call the enter_plan tool");
    expect(expand?.prompt).toContain("call exit_plan with the plan path");
    expect(expand?.prompt).not.toContain("Create a Goal");
    expect(expand?.prompt).not.toContain("planning-only Goal tasks");
  });

  it("defines /raise-floor as an inward, app-wide-first, tasks-handoff floor audit", () => {
    const raiseFloor = PROMPT_COMMANDS.find((command) => command.name === "raise-floor");

    expect(raiseFloor).toBeDefined();
    expect(raiseFloor?.aliases).toContain("floor");
    expect(raiseFloor?.prompt).toContain("Raise the Floor");
    expect(raiseFloor?.prompt).toContain("inward counterpart to /expand");
    expect(raiseFloor?.prompt).toContain("app-wide first, specific features second");
    expect(raiseFloor?.prompt).toContain("first-run scenario");
    expect(raiseFloor?.prompt).toContain("`tasks` tool");
    expect(raiseFloor?.prompt).toContain("Press Ctrl+T to open the task list");
    expect(raiseFloor?.prompt).toContain(
      "use kencode to reference working code. /commit when done.",
    );
    expect(raiseFloor?.prompt).toContain("A) Add tasks for all floor-raising fixes");
    expect(raiseFloor?.prompt).toContain("B) Add tasks for the app-wide fixes only");
    expect(raiseFloor?.prompt).toContain("D) None — report only");
    expect(raiseFloor?.prompt).toContain("Do not start implementing until the user chooses");
    expect(raiseFloor?.prompt).not.toContain("Create a Goal");
  });

  it("defines /elon as a subtractive, add-back-required, tasks-handoff deletion audit", () => {
    const elon = PROMPT_COMMANDS.find((command) => command.name === "elon");

    expect(elon).toBeDefined();
    expect(elon?.aliases).toContain("delete");
    expect(elon?.description).toContain("earns its place");
    expect(elon?.prompt).toContain("Deletion Algorithm");
    expect(elon?.prompt).toContain("SUBTRACTIVE sibling");
    expect(elon?.prompt).toContain("app-wide first, specific surfaces second");
    expect(elon?.prompt).toContain("required predicted add-back");
    expect(elon?.prompt).toContain("bullshit-detector");
    expect(elon?.prompt).toContain("simplification leverage");
    expect(elon?.prompt).toContain("deletion ledger");
    expect(elon?.prompt).toContain("`tasks` tool");
    expect(elon?.prompt).toContain("Press Ctrl+T to open the task list");
    expect(elon?.prompt).toContain("use kencode to reference working code. /commit when done.");
    expect(elon?.prompt).toContain("A) Add tasks for all confirmed deletions");
    expect(elon?.prompt).toContain("D) None — report only");
    expect(elon?.prompt).toContain("Do not delete or start implementing until the user chooses");
    expect(elon?.prompt).not.toContain("Create a Goal");
  });

  it("defines /test-drive as an empirical run-the-app, fix-blockers, file-tasks QA command", () => {
    const testDrive = PROMPT_COMMANDS.find((command) => command.name === "test-drive");

    expect(testDrive).toBeDefined();
    expect(testDrive?.aliases).toContain("qa");
    expect(testDrive?.aliases).toContain("td");
    expect(testDrive?.prompt).toContain("ACTUALLY RUN this app");
    expect(testDrive?.prompt).toContain("project-agnostic");
    expect(testDrive?.prompt).toContain("screenshot tool");
    expect(testDrive?.prompt).toContain("BLOCKING");
    expect(testDrive?.prompt).toContain("DEFERRABLE");
    expect(testDrive?.prompt).toContain("Fix these immediately");
    expect(testDrive?.prompt).toContain("`tasks` tool");
    expect(testDrive?.prompt).toContain("mcp__kencode-search__searchCode");
    expect(testDrive?.prompt).toContain("Press Ctrl+T to open the task list");
    expect(testDrive?.prompt).toContain(
      "use kencode to reference working code. /commit when done.",
    );
    expect(testDrive?.prompt).not.toContain("Create a Goal");
  });

  it("keeps /init focused on project-specific CLAUDE.md content", () => {
    const init = PROMPT_COMMANDS.find((command) => command.name === "init");

    expect(init).toBeDefined();
    expect(init?.prompt).toContain("project-specific context only");
    expect(init?.prompt).toContain("Do NOT add generic agent behavior");
    expect(init?.prompt).toContain("Remove generic guidance");
    expect(init?.prompt).toContain("Never add guidance that requires running checks");
    expect(init?.prompt).toContain("mandatory after-every-edit requirements");
    expect(init?.prompt).toContain("After editing ANY file");
    expect(init?.prompt).toContain(
      "Do not duplicate language style packs, generic verification rules",
    );
    expect(init?.prompt).toContain("Do NOT embed generated symbol maps");
    expect(init?.prompt).toContain("auto-generated project inventories");
    expect(init?.prompt).toContain("CLAUDE.md must remain durable, agent-focused project context");
    expect(init?.prompt).not.toContain("human-authored");
    expect(init?.prompt).not.toContain("one file per component");
    expect(init?.prompt).not.toContain("single responsibility");
    expect(init?.prompt).not.toContain("zero-tolerance code quality checks");
    expect(init?.prompt).not.toContain("run full quality suite after every edit");
  });
});
