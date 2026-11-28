import { afterEach, describe, expect, it } from "vitest";
import type { AgentDefinition } from "../core/agents.js";
import type { CreateToolsResult } from "./index.js";
import { createTools } from "./index.js";

const agent: AgentDefinition = {
  name: "researcher",
  description: "Researches a focused question",
  tools: ["read"],
  systemPrompt: "Research carefully.",
  source: "bundled",
};

const results: CreateToolsResult[] = [];

afterEach(async () => {
  await Promise.all(
    results.splice(0).map(async ({ processManager, lspManager, subAgentManager }) => {
      await subAgentManager?.shutdownAll();
      await lspManager?.shutdownAll();
      processManager.shutdownAll();
    }),
  );
});

describe("createTools subagent depth policy", () => {
  it("registers both blocking and persistent subagent tools for a parent", async () => {
    const result = await createTools(process.cwd(), {
      agents: [agent],
      provider: "openai",
      model: "gpt-6-luna",
      lspDiagnostics: false,
    });
    results.push(result);

    const names = result.tools.map((tool) => tool.name);
    expect(names).toContain("subagent");
    expect(names).toContain("spawn_agent");
    expect(result.subAgentManager).toBeDefined();
  });

  it("omits every subagent tool inside a persistent child worker", async () => {
    const result = await createTools(process.cwd(), {
      agents: [agent],
      provider: "openai",
      model: "gpt-6-luna",
      disableSubagents: true,
      lspDiagnostics: false,
    });
    results.push(result);

    const names = result.tools.map((tool) => tool.name);
    const delegationTools = [
      "subagent",
      "spawn_agent",
      "send_message",
      "followup_task",
      "wait_agent",
      "list_agents",
      "interrupt_agent",
    ];
    expect(names.filter((name) => delegationTools.includes(name))).toEqual([]);
    expect(result.subAgentManager).toBeUndefined();
  });
});

describe("createTools fleet approval wiring", () => {
  async function fleetTool(opts: Parameters<typeof createTools>[1]) {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ezf-wire-"));
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    const result = await createTools(cwd, {
      provider: "openai",
      model: "gpt-6-luna",
      lspDiagnostics: false,
      ...opts,
    });
    results.push(result);
    const tool = result.tools.find((t) => t.name === "fleet")!;
    const file = path.join(cwd, ".ezcoder", "fleet.json");
    const apply = (args: Record<string, unknown>) =>
      tool.execute({ action: "apply_config", ...args } as never, {} as never) as Promise<string>;
    return { apply, exists: () => fs.existsSync(file) };
  }

  it("asks the user through the host's askUser, even when the model claims approval", async () => {
    const asked: string[] = [];
    let answer = "no";
    const t = await fleetTool({
      askUser: async (request) => {
        asked.push(request.questions[0]!.question);
        return { action: "answer", answers: { apply: answer } };
      },
    });
    expect(await t.apply({ approved: true })).toMatch(/did not approve/);
    expect(t.exists()).toBe(false);
    answer = "yes";
    expect(await t.apply({})).toMatch(/^Wrote /);
    expect(t.exists()).toBe(true);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatch(/Write \.ezcoder[\\/]fleet\.json/);
  });

  it("does not take autopilot's answer as the user's approval", async () => {
    const t = await fleetTool({
      askUser: async () => ({ action: "answer", answers: { apply: "yes" }, by: "ken" }),
    });
    expect(await t.apply({})).toMatch(/needs the user's own yes/);
    expect(t.exists()).toBe(false);
  });

  it("without a host ask handler, tells the agent to ask first", async () => {
    const t = await fleetTool({});
    expect(await t.apply({})).toMatch(/ask \(ask_user\)/);
    expect(t.exists()).toBe(false);
    expect(await t.apply({ approved: true })).toMatch(/^Wrote /);
  });
});
