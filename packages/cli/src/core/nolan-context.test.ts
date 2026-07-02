import { describe, it, expect } from "vitest";
import os from "node:os";
import {
  buildNolanDigest,
  buildNolanAutopilotContext,
  AUTOPILOT_REVIEW_INSTRUCTION,
  NOLAN_RECENT_MESSAGE_LIMIT,
  INJECTED_PROMPT_LABEL,
} from "./nolan-context.js";
import { USER_INSTRUCTIONS_HEADER } from "./autopilot-gate.js";
import { PROMPT_COMMANDS } from "./prompt-commands.js";
import { createTools } from "../tools/index.js";
import type { Message } from "@prestyj/ai";

// Mirror the sidecar's Nolan allow-list so the filter test tracks the real set.
const NOLAN_ALLOWED_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "source_path",
  "web_fetch",
  "web_search",
  "screenshot",
];
const NOLAN_ALLOWED_MCP_SERVERS = ["kencode-search"];

// Mirror of AgentSession.isToolAllowed (which is private): a tool passes when
// its name is in the allow-list, OR it's an mcp__<server>__<tool> whose server
// is whitelisted. Kept in lockstep so this test tracks the real filter.
function isToolAllowed(name: string): boolean {
  if (NOLAN_ALLOWED_TOOLS.includes(name)) return true;
  if (name.startsWith("mcp__")) {
    const server = name.slice("mcp__".length).split("__")[0];
    return NOLAN_ALLOWED_MCP_SERVERS.includes(server);
  }
  return false;
}

describe("Nolan allowedTools filter", () => {
  it("excludes every mutating tool from the Nolan set", async () => {
    const { tools, processManager, lspManager } = await createTools(os.tmpdir(), {
      lspDiagnostics: false,
    });
    try {
      const nolanTools = tools.filter((t) => isToolAllowed(t.name)).map((t) => t.name);

      // The mutating / orchestration tools must NOT survive the filter.
      for (const banned of ["write", "edit", "bash", "tasks", "subagent", "generate_image"]) {
        expect(nolanTools).not.toContain(banned);
      }
      // The read-only research/vision tools must survive.
      for (const allowed of ["read", "grep", "find", "ls", "screenshot"]) {
        expect(nolanTools).toContain(allowed);
      }
    } finally {
      processManager.shutdownAll();
      lspManager?.shutdownAll();
    }
  });

  it("allows whitelisted kencode-search MCP tools but blocks other MCP tools", () => {
    // kencode-search is Nolan's research server: all its tools pass.
    expect(isToolAllowed("mcp__kencode-search__searchCode")).toBe(true);
    expect(isToolAllowed("mcp__kencode-search__referenceSources")).toBe(true);
    expect(isToolAllowed("mcp__kencode-search__discoverRepos")).toBe(true);
    // A non-whitelisted MCP server (e.g. a user-configured one) is blocked,
    // even if it exposes an innocuous-looking name.
    expect(isToolAllowed("mcp__some-other-server__searchCode")).toBe(false);
    expect(isToolAllowed("mcp__filesystem__write_file")).toBe(false);
  });
});

describe("buildNolanDigest", () => {
  const base = {
    question: "what next?",
    projectContext: ["### CLAUDE.md\n\nBuild a todo app."],
    cwd: "/tmp/proj",
    gitBranch: "main" as string | null,
    platform: "darwin",
  };

  it("includes the project context, env, and the question", () => {
    const digest = buildNolanDigest({ ...base, messages: [] });
    expect(digest).toContain("Build a todo app.");
    expect(digest).toContain("/tmp/proj");
    expect(digest).toContain("main");
    expect(digest).toContain("what next?");
    expect(digest).toContain("(no conversation yet)");
  });

  it("caps recent activity at the last-N messages", () => {
    const messages: Message[] = [];
    for (let i = 0; i < NOLAN_RECENT_MESSAGE_LIMIT + 10; i++) {
      messages.push({ role: "user", content: `msg-${i}` });
    }
    const digest = buildNolanDigest({ ...base, messages });
    // The earliest messages fall outside the cap.
    expect(digest).not.toContain("msg-0");
    expect(digest).not.toContain("msg-5");
    // The newest message is kept.
    expect(digest).toContain(`msg-${NOLAN_RECENT_MESSAGE_LIMIT + 9}`);
  });

  it("strips image blocks from user messages", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", mediaType: "image/png", data: "AAAABBBBCCCC" },
        ],
      },
    ];
    const digest = buildNolanDigest({ ...base, messages });
    expect(digest).toContain("look at this");
    expect(digest).not.toContain("AAAABBBBCCCC");
  });

  it("buildNolanAutopilotContext injects the fixed review instruction as the question", () => {
    const messages: Message[] = [
      { role: "user", content: "add a login form" },
      { role: "assistant", content: "Added the form." },
    ];
    const digest = buildNolanAutopilotContext({
      projectContext: base.projectContext,
      cwd: base.cwd,
      gitBranch: base.gitBranch,
      platform: base.platform,
      messages,
    });
    // The transcript is still inlined (Nolan reviews it) ...
    expect(digest).toContain("add a login form");
    expect(digest).toContain("Added the form.");
    // ... and the trailing question is the fixed autopilot instruction, not a
    // user-typed one.
    expect(digest).toContain(AUTOPILOT_REVIEW_INSTRUCTION);
    expect(digest).toContain("PROMPT");
    expect(digest).toContain("ALL_CLEAR");
    expect(digest).toContain("HUMAN");
  });

  it("autopilot review instruction covers the ask-the-user and injected-prompt rules", () => {
    // EZ Coder ending with a question/options must resolve to HUMAN, and Nolan
    // must be told injected lines are his own — these are leak regressions.
    expect(AUTOPILOT_REVIEW_INSTRUCTION).toContain("asking the user a question");
    expect(AUTOPILOT_REVIEW_INSTRUCTION).toContain("HUMAN");
    expect(AUTOPILOT_REVIEW_INSTRUCTION).toContain("Original user request");
    expect(AUTOPILOT_REVIEW_INSTRUCTION).toContain("Nolan autopilot (injected)");
  });

  it("uses the latest compaction summary as the story-so-far base", () => {
    const messages: Message[] = [
      { role: "user", content: "old turn that should be summarized away" },
      { role: "user", content: "[Previous conversation summary]\n\nWe scaffolded the app." },
      { role: "assistant", content: "Added the header." },
    ];
    const digest = buildNolanDigest({ ...base, messages });
    expect(digest).toContain("Story so far");
    expect(digest).toContain("We scaffolded the app.");
    // Pre-summary messages are not echoed into recent activity.
    expect(digest).not.toContain("old turn that should be summarized away");
    // Post-summary activity is kept.
    expect(digest).toContain("Added the header.");
  });
});

describe("buildNolanDigest — original request pinning", () => {
  const base = {
    question: "review it",
    projectContext: [] as string[],
    cwd: "/tmp/proj",
    gitBranch: "main" as string | null,
    platform: "darwin",
  };

  it("pins the original request in its own section", () => {
    const digest = buildNolanDigest({
      ...base,
      messages: [],
      originalRequest: "build a login form with validation",
    });
    expect(digest).toContain("## Original user request (the turn under review)");
    expect(digest).toContain("build a login form with validation");
  });

  it("keeps the original request even when it scrolled out of recent activity", () => {
    // The drift bug: multi-round cycles push the real ask out of the rolling
    // 20-message window. The pinned section must survive that.
    const messages: Message[] = [{ role: "user", content: "THE-REAL-ASK: add dark mode" }];
    for (let i = 0; i < NOLAN_RECENT_MESSAGE_LIMIT + 5; i++) {
      messages.push({ role: "assistant", content: `working… step ${i}` });
    }
    const digest = buildNolanDigest({
      ...base,
      messages,
      originalRequest: "THE-REAL-ASK: add dark mode",
    });
    // Scrolled out of recent activity…
    expect(digest.split("## Original user request")[0]).not.toContain("THE-REAL-ASK");
    // …but pinned in its own section.
    expect(digest.split("## Original user request")[1]).toContain("THE-REAL-ASK: add dark mode");
  });

  it("gives the pinned request far more room than a recent-activity line", () => {
    // Recent-activity lines truncate at 1500 chars; the ask under review must
    // not be judged against a mid-sentence cut, so its cap is 4000.
    const longAsk = "requirement " + "x".repeat(3000);
    const digest = buildNolanDigest({ ...base, messages: [], originalRequest: longAsk });
    const pinned = digest.split("## Original user request")[1];
    expect(pinned).toContain("x".repeat(3000));
  });

  it("omits the section when there is no original request (chat Nolan)", () => {
    const digest = buildNolanDigest({ ...base, messages: [] });
    expect(digest).not.toContain("## Original user request");
  });
});

describe("buildNolanDigest — injected-prompt labeling", () => {
  const base = {
    question: "review it",
    projectContext: [] as string[],
    cwd: "/tmp/proj",
    gitBranch: null,
    platform: "darwin",
  };

  it("labels autopilot-injected prompts as Nolan's, never **User:**", () => {
    const injected = "Fix the failing auth test and prove it by running it.";
    const messages: Message[] = [
      { role: "user", content: "add auth" },
      { role: "assistant", content: "Added auth." },
      { role: "user", content: injected },
      { role: "assistant", content: "Fixed the test." },
    ];
    const digest = buildNolanDigest({ ...base, messages, injectedPrompts: [injected] });
    expect(digest).toContain(`${INJECTED_PROMPT_LABEL} ${injected}`);
    expect(digest).not.toContain(`**User:** ${injected}`);
    // Real user asks keep the normal label.
    expect(digest).toContain("**User:** add auth");
  });

  it("matches injected prompts through whitespace drift", () => {
    const injected = "Fix the failing test.";
    const messages: Message[] = [{ role: "user", content: `  ${injected}  ` }];
    const digest = buildNolanDigest({ ...base, messages, injectedPrompts: [injected] });
    expect(digest).toContain(INJECTED_PROMPT_LABEL);
  });
});

describe("buildNolanDigest — workflow-command labeling", () => {
  const base = {
    question: "review it",
    projectContext: [] as string[],
    cwd: "/tmp/proj",
    gitBranch: null,
    platform: "darwin",
  };
  const compare = PROMPT_COMMANDS.find((c) => c.name === "compare")!;

  it("renders an expanded template as a short command note, not a user ask", () => {
    // AgentSession.prompt() stores the EXPANDED template as a plain user
    // message; the digest must not present 400 template lines as **User:**.
    const messages: Message[] = [
      { role: "user", content: compare.prompt },
      { role: "assistant", content: "Compared against 12 repos, all aligned." },
    ];
    const digest = buildNolanDigest({ ...base, messages, workflowCommands: PROMPT_COMMANDS });
    expect(digest).toContain("**User:** [ran workflow command /compare]");
    // The template body itself never leaks into the digest.
    expect(digest).not.toContain("Compare the code you just created or modified");
  });

  it("keeps the user's own args from an expanded command", () => {
    const messages: Message[] = [
      { role: "user", content: `${compare.prompt}${USER_INSTRUCTIONS_HEADER}only src/auth.ts` },
    ];
    const digest = buildNolanDigest({ ...base, messages, workflowCommands: PROMPT_COMMANDS });
    expect(digest).toContain("[ran workflow command /compare]");
    expect(digest).toContain("only src/auth.ts");
  });

  it("leaves ordinary user text untouched when specs are provided", () => {
    const messages: Message[] = [{ role: "user", content: "please compare my two branches" }];
    const digest = buildNolanDigest({ ...base, messages, workflowCommands: PROMPT_COMMANDS });
    expect(digest).toContain("**User:** please compare my two branches");
  });
});
