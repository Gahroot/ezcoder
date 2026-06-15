// Canned, realistic seed data for the screenshot showcase. None of this touches
// the real sidecar — it's only used by `tauri-mock.ts` to render every screen
// with believable content for the landing-page captures.

import type {
  AgentState,
  AuthProvider,
  DiscoveredProject,
  HistoryEntry,
  ModelOption,
  ProjectTask,
  RecentSession,
  SlashCommand,
} from "../src/agent";

export const PROJECTS_ROOT = "/Users/nolan/ez-projects";

export const PROVIDERS: AuthProvider[] = [
  {
    value: "anthropic",
    label: "Anthropic — Claude",
    description:
      "Claude Opus & Sonnet. Sign in with your Claude subscription (OAuth) or an API key.",
    methods: ["oauth", "apikey"],
    apiKeyLabel: "Anthropic API key",
    connected: true,
  },
  {
    value: "openai",
    label: "OpenAI",
    description: "GPT-5 and o-series reasoning models. OAuth with ChatGPT or paste an API key.",
    methods: ["oauth", "apikey"],
    apiKeyLabel: "OpenAI API key",
    connected: true,
  },
  {
    value: "google",
    label: "Google — Gemini",
    description: "Gemini 2.5 Pro & Flash. Long context, fast and cheap.",
    methods: ["apikey"],
    apiKeyLabel: "Gemini API key",
    connected: false,
  },
  {
    value: "xai",
    label: "xAI — Grok",
    description: "Grok 4. Bring your xAI API key.",
    methods: ["apikey"],
    apiKeyLabel: "xAI API key",
    connected: false,
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    description: "One key, hundreds of models. Great for trying everything.",
    methods: ["apikey"],
    apiKeyLabel: "OpenRouter API key",
    connected: false,
  },
  {
    value: "groq",
    label: "Groq",
    description: "Open models at absurd speed on Groq's LPUs.",
    methods: ["apikey"],
    apiKeyLabel: "Groq API key",
    connected: false,
  },
];

export const MODELS: ModelOption[] = [
  { id: "claude-opus-4", name: "Claude Opus 4", provider: "anthropic" },
  { id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" },
  { id: "claude-haiku-4", name: "Claude Haiku 4", provider: "anthropic" },
  { id: "gpt-5", name: "GPT-5", provider: "openai" },
  { id: "gpt-5-mini", name: "GPT-5 mini", provider: "openai" },
  { id: "o4-mini", name: "o4-mini", provider: "openai" },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "google" },
  { id: "grok-4", name: "Grok 4", provider: "xai" },
];

export const COMMANDS: SlashCommand[] = [
  {
    name: "commit",
    aliases: [],
    description: "Stage, write a message, and commit",
    source: "built-in",
  },
  {
    name: "review",
    aliases: [],
    description: "Review the working tree for bugs & risks",
    source: "built-in",
  },
  { name: "plan", aliases: [], description: "Enter read-only plan mode", source: "built-in" },
  {
    name: "test",
    aliases: [],
    description: "Run the smallest relevant test suite",
    source: "built-in",
  },
  {
    name: "pr",
    aliases: [],
    description: "Open a pull request from this branch",
    source: "custom",
  },
  {
    name: "explain",
    aliases: [],
    description: "Explain the selected file or symbol",
    source: "custom",
  },
  {
    name: "compact",
    aliases: [],
    description: "Summarize & shrink the context window",
    source: "built-in",
  },
];

export const PROJECTS: DiscoveredProject[] = [
  {
    name: "ezcoder",
    path: "/Users/nolan/code/ezcoder",
    lastActiveDisplay: "2h ago",
    sources: ["ezcoder"],
  },
  {
    name: "pixel-server",
    path: "/Users/nolan/code/pixel-server",
    lastActiveDisplay: "yesterday",
    sources: ["ezcoder", "claude-code"],
  },
  {
    name: "acme-saas",
    path: "/Users/nolan/code/acme-saas",
    lastActiveDisplay: "3d ago",
    sources: ["claude-code"],
  },
  {
    name: "voice-bot",
    path: "/Users/nolan/code/voice-bot",
    lastActiveDisplay: "last week",
    sources: ["codex"],
  },
  {
    name: "portfolio",
    path: "/Users/nolan/ez-projects/portfolio",
    lastActiveDisplay: "2 weeks ago",
    sources: ["ezcoder"],
  },
  {
    name: "ez-pixel-rs",
    path: "/Users/nolan/code/ez-pixel-rs",
    lastActiveDisplay: "last month",
    sources: ["ezcoder", "codex"],
  },
];

export const SESSIONS: RecentSession[] = [
  {
    id: "s1",
    path: "/sessions/s1.json",
    preview: "Build the landing-page showcase harness",
    lastActiveDisplay: "2h ago",
    messageCount: 42,
  },
  {
    id: "s2",
    path: "/sessions/s2.json",
    preview: "Fix the updater endpoint returning 404 on latest.json",
    lastActiveDisplay: "yesterday",
    messageCount: 18,
  },
  {
    id: "s3",
    path: "/sessions/s3.json",
    preview: "Refactor project discovery into one shared module",
    lastActiveDisplay: "3d ago",
    messageCount: 67,
  },
  {
    id: "s4",
    path: "/sessions/s4.json",
    preview: "Wire Telegram remote control end-to-end",
    lastActiveDisplay: "last week",
    messageCount: 31,
  },
];

export const TASKS: ProjectTask[] = [
  {
    id: "t1",
    title: "Scaffold the sidecar HTTP + SSE seam",
    prompt: "",
    status: "done",
    createdAt: "",
  },
  {
    id: "t2",
    title: "Capture every screen for the landing page",
    prompt: "",
    status: "in-progress",
    createdAt: "",
  },
  {
    id: "t3",
    title: "Write the GitHub Pages deploy workflow",
    prompt: "",
    status: "pending",
    createdAt: "",
  },
  {
    id: "t4",
    title: "Add platform-aware download buttons",
    prompt: "",
    status: "pending",
    createdAt: "",
  },
];

export const STATE: AgentState = {
  provider: "anthropic",
  model: "claude-sonnet-4",
  cwd: "/Users/nolan/code/ezcoder",
  running: false,
  thinkingLevel: "medium",
  supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
  planMode: false,
  contextWindow: 200_000,
  gitBranch: "main",
  isGitRepo: true,
  tasks: [],
};

export const HISTORY: HistoryEntry[] = [
  {
    role: "user",
    text: "Add a context-window meter to the footer so I can see how full the prompt is getting.",
  },
  {
    role: "assistant",
    text: [
      "On it. Here's the plan:",
      "",
      "1. Add a `ContextMeter` component that renders a thin bar tinted by usage.",
      "2. Feed it `contextTokens / contextWindow` from the live agent state.",
      "3. Drop it into the footer-right group, before the model picker.",
      "",
      "I read `App.tsx` and `theme.ts` — the footer already tracks `contextTokens`, so I just need to surface it.",
    ].join("\n"),
  },
  {
    role: "user",
    text: "Perfect. Make it go amber past 70% and red past 90%.",
  },
  {
    role: "assistant",
    text: [
      "Done. The meter now interpolates green → amber → red by percentage:",
      "",
      "```tsx",
      "const color = pct > 0.9 ? theme.error : pct > 0.7 ? theme.warning : theme.success;",
      "return <span className=\"context-meter\" style={{ ['--pct' as string]: pct }} />;",
      "```",
      "",
      "I also added a tooltip showing the exact token count, and verified `pnpm check` and `pnpm lint` pass. Want me to commit it?",
    ].join("\n"),
  },
];

/** A realistic plan-review markdown body. */
export const PLAN_MARKDOWN = [
  "## Goal",
  "Ship a public landing page for the EZ Coder desktop app with real screenshots and platform-aware download buttons.",
  "",
  "## Steps",
  "1. **Screens** — render every app screen with seeded data and capture clean PNGs.",
  "2. **Site** — build a static, dependency-free page: hero, feature grid, screenshot gallery, FAQ.",
  "3. **Downloads** — fetch the latest GitHub release and surface the right asset per-OS, with a fallback to the releases page.",
  "4. **Deploy** — add a GitHub Pages workflow that publishes `website/` on every push to `main`.",
  "",
  "## Verification",
  "- `pnpm --filter ezcoder-app build` stays green.",
  "- The page renders offline and the download buttons resolve once a `v*` tag is published.",
].join("\n");

export const RADIO_STATIONS = [
  { id: "lofi", name: "Lofi beats", description: "chill coding loops", url: "" },
  { id: "synthwave", name: "Synthwave", description: "neon night drive", url: "" },
  { id: "jazz", name: "Jazz", description: "late-night keys", url: "" },
];
