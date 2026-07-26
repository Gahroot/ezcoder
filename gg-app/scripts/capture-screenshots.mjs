/**
 * README screenshot harness.
 *
 * Boots the Vite dev server's webview in headless Chromium with a FAKE Tauri IPC
 * layer (`window.__TAURI_INTERNALS__`), so every screenshot is rendered from
 * synthetic demo data defined in this file. Nothing from `~/.gg` — no real
 * sessions, project paths, chat content, tokens, or account names — can ever
 * reach a committed image.
 *
 * Usage:
 *   pnpm --filter gg-app dev            # terminal 1 (http://localhost:1420)
 *   node gg-app/scripts/capture-screenshots.mjs
 *
 * Output: docs/screenshots/*.png (referenced by the root README).
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../../docs/screenshots");
const url = process.env.GG_SHOT_URL ?? "http://localhost:1420";
const viewport = { width: 1440, height: 900 };

// ── Demo data ────────────────────────────────────────────────────────────────
// Deliberately fictional. Keep it that way.
const DEMO = {
  cwd: "/Users/demo/projects/aurora-store",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  projects: [
    { name: "aurora-store", path: "/Users/demo/projects/aurora-store" },
    { name: "pixel-pipeline", path: "/Users/demo/projects/pixel-pipeline" },
    { name: "rusty-parser", path: "/Users/demo/projects/rusty-parser" },
    { name: "landing-page", path: "/Users/demo/projects/landing-page" },
  ],
  sessions: [
    "Add checkout retry with idempotency keys",
    "Port the image resizer to sharp",
    "Fix flaky cart integration test",
  ],
};

const state = {
  provider: DEMO.provider,
  model: DEMO.model,
  cwd: DEMO.cwd,
  mode: "code",
  running: false,
  runState: "idle",
  thinkingLevel: "medium",
  supportedThinkingLevels: ["low", "medium", "high"],
  planMode: false,
  contextWindow: 200000,
  gitBranch: "main",
  isGitRepo: true,
  gitDirtyFileCount: 3,
  gitHubIssues: 4,
  gitHubPRs: 1,
  gitHubRepoUrl: "https://github.com/demo/aurora-store",
  supportsVideo: false,
  autopilot: false,
  kenProvider: DEMO.provider,
  kenModel: DEMO.model,
  kenModelOverride: false,
  tasks: [],
};

const authProviders = [
  ["anthropic", "Anthropic", "Claude models", true],
  ["openai", "OpenAI", "Codex + GPT models", true],
  ["gemini", "Google Gemini", "Gemini models", false],
  ["moonshot", "Moonshot", "Kimi models", false],
  ["glm", "Z.ai", "GLM models", false],
  ["minimax", "MiniMax", "MiniMax models", false],
  ["deepseek", "DeepSeek", "DeepSeek models", false],
  ["xai", "xAI", "Grok models", false],
].map(([value, label, description, connected]) => ({
  value,
  label,
  description,
  methods: ["oauth", "apikey"],
  connected,
}));

const models = [
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "claude-opus-4-1", name: "Claude Opus 4.1", provider: "anthropic" },
  { id: "gpt-5-codex", name: "GPT-5 Codex", provider: "openai" },
  { id: "gemini-3-pro", name: "Gemini 3 Pro", provider: "gemini" },
  { id: "kimi-k3", name: "Kimi K3", provider: "moonshot" },
  {
    id: "local/ollama/qwen3-coder:30b",
    name: "qwen3-coder:30b",
    provider: "local",
    local: true,
    endpoint: "Ollama",
    supportsTools: true,
    contextWindow: 262144,
    contextWindowKnown: true,
  },
].map((m) => ({ supportsThinking: true, contextWindow: 200000, ...m }));

const commands = [
  ["init", "Analyze the project and write a CLAUDE.md"],
  ["plan", "Enter read-only plan mode"],
  ["commit", "Stage, write a message, and commit"],
  ["review", "Review the working tree for bugs"],
  ["compact", "Compact the conversation to free context"],
  ["model", "Switch the active model"],
  ["add-dir", "Add another workspace root"],
  ["memory", "Show what the agent remembers"],
].map(([name, description]) => ({ name, aliases: [], description, source: "built-in" }));

const progress = {
  level: 14,
  rankName: "Shipwright",
  tier: 3,
  tierName: "Gold",
  tierGlyph: "◆",
  effectId: "gold",
  xp: 18240,
  xpIntoLevel: 740,
  xpForLevel: 1200,
  percent: 62,
  streak: { current: 9, best: 21 },
  totals: { prompts: 1284, commits: 337, linesShipped: 91240, projects: 7 },
  xpBySource: { prompts: 9820, commits: 6410, streakBonus: 2010 },
  memberSince: "2026-01-14T00:00:00.000Z",
  ladder: [],
  levelUp: null,
  eventNonce: null,
};

const usage = {
  provider: "anthropic",
  displayName: "Anthropic",
  connected: true,
  windows: [
    { kind: "current", label: "5-hour", usedPercent: 34, resetsAt: Date.now() + 96 * 60_000 },
    {
      kind: "weekly",
      label: "Weekly",
      usedPercent: 58,
      resetsAt: Date.now() + 3.5 * 24 * 60 * 60_000,
    },
  ],
  fetchedAt: Date.now(),
};

const localModel = (rawId, ctx, extra = {}) => ({
  id: `local/ollama/${rawId}`,
  rawId,
  contextWindow: ctx,
  contextWindowKnown: true,
  supportsTools: true,
  supportsImages: false,
  supportsThinking: false,
  ...extra,
});

const localModels = {
  endpoints: [
    {
      id: "ollama",
      label: "Ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      kind: "ollama",
      custom: false,
      reachable: true,
      models: [
        localModel("qwen3-coder:30b", 262144, { supportsThinking: true }),
        localModel("deepseek-r1:14b", 131072, { supportsThinking: true }),
        localModel("llama3.2", 131072),
        localModel("embeddinggemma", 2048, { supportsTools: false }),
      ],
    },
    {
      id: "lmstudio",
      label: "LM Studio",
      baseUrl: "http://127.0.0.1:1234/v1",
      kind: "lmstudio",
      custom: false,
      reachable: false,
      reason: "LM Studio isn't running at http://127.0.0.1:1234/v1",
      models: [],
    },
  ],
};

// Command → canned response. Anything unlisted resolves to null (harmless).
const responses = {
  sidecar_port: 45678,
  agent_state: state,
  agent_progress: progress,
  agent_usage: usage,
  app_auth_status: { providers: authProviders },
  app_settings_get: { projectsRoot: "/Users/demo/projects", configured: true },
  agent_serve_status: { running: false, configured: false },
  agent_models: { models },
  agent_commands: { commands },
  agent_tasks: { tasks: [] },
  agent_memories: { memories: [] },
  agent_jiwa: { jiwa: [] },
  agent_local: localModels,
  agent_local_scan: localModels,
  agent_radio_state: { playing: false, station: null },
  permissions_status: { screenRecording: true, accessibility: true, microphone: true },
  agent_projects: {
    projects: DEMO.projects.map((p, i) => ({
      ...p,
      lastActiveDisplay: ["2m ago", "1h ago", "yesterday", "3d ago"][i],
      sources: [["gg-coder"], ["gg-coder", "claude-code"], ["codex"], ["gg-coder"]][i],
    })),
  },
  agent_sessions: {
    sessions: DEMO.sessions.map((preview, i) => ({
      id: `demo-session-${i + 1}`,
      path: DEMO.cwd,
      preview,
      lastActiveDisplay: ["12m ago", "2h ago", "yesterday"][i],
      messageCount: [24, 61, 8][i],
    })),
  },
};

function initScript(payload) {
  const { responses, appVersion } = payload;
  const callbacks = new Map();
  // event name → set of callback ids registered through `plugin:event|listen`.
  const eventHandlers = new Map();
  let nextId = 1;
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    plugins: {},
    convertFileSrc: (p) => p,
    transformCallback(cb) {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    invoke(cmd, args) {
      if (cmd === "plugin:app|version") return Promise.resolve(appVersion);
      if (cmd === "plugin:event|listen") {
        const name = args?.event;
        const handler = args?.handler;
        if (typeof name === "string" && typeof handler === "number") {
          if (!eventHandlers.has(name)) eventHandlers.set(name, new Set());
          eventHandlers.get(name).add(handler);
        }
        return Promise.resolve(nextId++);
      }
      if (cmd.startsWith("plugin:event|")) return Promise.resolve(null);
      if (cmd.startsWith("plugin:log|")) return Promise.resolve(null);
      if (cmd.startsWith("plugin:window|") || cmd.startsWith("plugin:webview|")) {
        return Promise.resolve(null);
      }
      if (cmd.startsWith("plugin:updater|")) return Promise.reject(new Error("no updates"));
      return Promise.resolve(cmd in responses ? responses[cmd] : null);
    },
  };

  // Drive the transcript from the test: replays what the Rust shell would
  // forward from the sidecar's SSE stream.
  window.__ggEmit = (type, data) => {
    const ids = eventHandlers.get("agent-event");
    if (!ids) return 0;
    for (const id of ids) {
      callbacks.get(id)?.({ event: "agent-event", id, payload: { type, data: data ?? {} } });
    }
    return ids.size;
  };

  // Silence the media/webcam surfaces that have no place in a screenshot.
  Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
}

/**
 * Replay an entirely fictional run so the chat screenshot has substance.
 * Turn 1 completes; turn 2 is left mid-flight so the live tool panel, the
 * activity bar, and the streaming bubble are all on screen at once.
 */
async function playDemoConversation(page) {
  const emit = (type, data) => page.evaluate(([t, d]) => window.__ggEmit(t, d), [type, data ?? {}]);
  const say = async (text) => {
    await page.fill("textarea", text);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
  };
  const stream = async (chunks) => {
    for (const chunk of chunks) {
      await emit("text_delta", { text: chunk });
      await page.waitForTimeout(90);
    }
  };
  // A `null` result leaves that tool running (used for the final shot).
  const runTools = async (tools) => {
    for (const [id, name, args, result] of tools) {
      await emit("tool_call_start", { toolCallId: id, name, args });
      await page.waitForTimeout(160);
      if (result !== null) {
        await emit("tool_call_end", { toolCallId: id, result, isError: false });
        await page.waitForTimeout(90);
      }
    }
  };

  // ── Turn 1 (completes) ─────────────────────────────────────────────────────
  await say("Why does the checkout endpoint double-charge on a flaky connection?");
  await emit("run_start", {});
  await emit("thinking_delta", { text: "…" });
  await runTools([
    ["t1", "grep", { pattern: "idempotenc", include: "*.ts" }, "no matches"],
    ["t2", "read", { file_path: "src/routes/checkout.ts" }, "read 184 lines"],
  ]);
  await stream([
    "`POST /api/checkout` calls the payment provider directly with no replay ",
    "protection, so the client's automatic retry lands as a second charge.\n\n",
    "The fix is an **idempotency key**: hash the cart + user, store the first ",
    "response for 24h, and return the cached result on a repeat.",
  ]);
  await emit("turn_end", {
    usage: { inputTokens: 18240, outputTokens: 640, cacheRead: 41200, cacheWrite: 2100 },
  });
  await emit("agent_done", {});
  await emit("run_end", {});
  await page.waitForTimeout(400);

  // ── Turn 2 (left running) ──────────────────────────────────────────────────
  await say("Do it, and add a regression test");
  await emit("run_start", {});
  await emit("thinking_delta", { text: "…" });
  await runTools([
    ["t3", "write", { file_path: "src/lib/idempotency.ts" }, "wrote 62 lines"],
    ["t4", "edit", { file_path: "src/routes/checkout.ts" }, "1 edit applied"],
    ["t5", "edit", { file_path: "src/routes/checkout.test.ts" }, "1 edit applied"],
    ["t6", "bash", { command: "pnpm vitest run src/routes" }, null],
  ]);
  await stream([
    "Added `src/lib/idempotency.ts` and wired it into the checkout route — ",
    "replays now collapse onto the first charge. Running the suite",
  ]);
  await page.waitForTimeout(400);
}

// Noteworthy screens only — the ones that actually sell the app. Not a tour.
const shots = [
  {
    name: "01-home",
    settle: 2200,
  },
  {
    name: "02-chat",
    viewport: { width: 1440, height: 800 },
    actions: [{ click: "text=Code" }, { click: ".picker-item" }, { click: "text=+ New session" }],
    settle: 1200,
    play: playDemoConversation,
  },
  {
    name: "03-projects",
    actions: [{ click: "text=Code" }],
    settle: 1400,
  },
  {
    name: "04-providers",
    viewport: { width: 1440, height: 1180 },
    actions: [{ click: "text=Login to AI Providers" }],
    settle: 900,
  },
  {
    name: "05-local-models",
    actions: [{ click: "text=Login to AI Providers" }, { click: "text=Local models" }],
    settle: 1200,
  },
  // NOTE: no model-picker shot. On macOS `ModelSelect` renders a native <select>
  // popup, which is an OS-level window Chromium cannot capture.
];

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const results = [];
  for (const shot of shots) {
    const context = await browser.newContext({
      viewport: shot.viewport ?? viewport,
      deviceScaleFactor: 2,
    });
    await context.addInitScript(initScript, { responses, appVersion: "0.29.0" });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`  [console] ${m.text().slice(0, 160)}`);
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    for (const action of shot.actions ?? []) {
      try {
        await page.click(action.click, { timeout: 5000 });
      } catch {
        console.log(`  ! click failed: ${action.click}`);
      }
      await page.waitForTimeout(600);
    }
    if (shot.play) await shot.play(page);
    await page.waitForTimeout(shot.settle ?? 1000);
    // Opening a modal from a tile scrolls its container; reset so the screen
    // behind the modal is framed from the top rather than mid-scroll.
    if (!shot.play) {
      await page.evaluate(() => {
        window.scrollTo(0, 0);
        for (const el of document.querySelectorAll("*")) {
          if (el.scrollTop > 0) el.scrollTop = 0;
        }
      });
      await page.waitForTimeout(250);
    }
    const file = resolve(outDir, `${shot.name}.png`);
    await page.screenshot({ path: file });
    results.push(file);
    console.log(`✓ ${shot.name}`);
    await context.close();
  }
  await browser.close();
  console.log(`\n${results.length} screenshot(s) → ${outDir}`);
}

await main();
