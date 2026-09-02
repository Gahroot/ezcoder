/**
 * Human-readable release notes shown in the dedicated "What's new" window.
 *
 * MAINTENANCE: this list is rewritten by the `/release` flow documented in
 * `.ezcoder/commands/release.md` (Track B). Keep entries newest-first and keep
 * every item focused on one user-visible improvement.
 */
export interface ChangelogEntry {
  /** App version this entry ships in, without a leading "v". */
  version: string;
  /** Release date, ISO `YYYY-MM-DD`. */
  date: string;
  /** One cohesive bullet per distinct feature; backticks highlight controls and names. */
  items: string[];
}

/** Newest first. Prepended by the `/release` flow. */
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.1.67",
    date: "2026-09-02",
    items: [
      "I fixed the `window arranger` after the new update dialog got mixed into its project count. Project windows tile correctly again while utility windows stay put.",
    ],
  },
  {
    version: "0.1.66",
    date: "2026-09-02",
    items: [
      "I fixed `Install Steroids` so one click works again. EZ Coder now grabs the right verified download on macOS and Windows.",
    ],
  },
  {
    version: "0.1.65",
    date: "2026-09-02",
    items: [
      "I gave EZ Coder a built-in research engine. The new `Steroids` tool finds proven patterns in real projects without extra setup, so your code starts from stronger examples.",
      "I added `Claude Fable 5.1` and smarter platform detection. EZ Coder now understands more of the tools already installed on your machine and picks from the latest model lineup.",
      "Questions are cleaner and easier to change. The new `one-row answers` keep choices compact while letting you revise them before moving on.",
      "Background windows finally know when to chill. I pause decorative motion while they are unfocused, cutting wasted battery and graphics work without changing your active session.",
      "I tightened `workspace protection` so linked paths cannot write beyond your project. Your files stay inside the boundaries you chose.",
    ],
  },
  {
    version: "0.1.64",
    date: "2026-08-26",
    items: [
      "Download local Hugging Face models from a searchable picker with live progress, and send images to GLM models across macOS, Linux, and Windows.",
      "Long transcripts stay pinned while streaming, stale status text clears correctly, and the composer resizes without jumping around.",
      "Autopilot now reviews plan structure, respects whole-reply limits, handles compound verification commands, and recovers from more interrupted runs.",
      "Sandbox socket access is explicit, invisible Unicode is stripped from fetched and MCP content, and vulnerable transitive dependencies were refreshed.",
      "Settings no longer shows the inactive Agent plugins installer.",
    ],
  },
  {
    version: "0.1.63",
    date: "2026-08-17",
    items: [
      "The local sidecar now authenticates every request, and project MCP servers ask for trust before they can run.",
      "GLM-5.3 is ready, with new Bulletproof, Lean, and Durable skills bundled in.",
      "EZ now verifies code after edits, wakes background jobs when they need attention, and tracks review coverage more clearly.",
      "Queued prompts promote smoothly, while meme controls and rendering behave themselves again.",
      "Safer edits and empty-response recovery mean fewer weird dead ends. Tiny miracles, shipped.",
    ],
  },
  {
    version: "0.1.62",
    date: "2026-08-11",
    items: [
      "Code exploration just got serious. EZ Coder now combines `LSP navigation`, multi-language search, and on-demand tool tiers so it can find the right symbol faster without stuffing every tool into every request.",
      "Your specialist agents are built in and ready to delegate. `bee`, `owl`, `auditor`, and `skeptic` now resolve their prompts, models, and tools consistently while Goals and task updates keep working across desktop sessions.",
      "Grok sign-in now supports `subscription OAuth` with a clean API-key fallback, including headless login and safe token refresh when several EZ Coder windows are open.",
      "Long-running work is harder to knock over. Provider timeouts retry safely, streamed gateway failures surface clearly, TPM limits classify correctly, and EZ Coder keeps its extended streaming and non-streaming limits.",
      "The desktop is steadier across the details that matter: persistent tab names, duplicate-title prevention, multi-monitor tiling, shared daemon sessions, task reconciliation, and rotating logs all survive the upgrade.",
      "MCP tools can return images, terminal output follows your active theme, and the new `compliance-guard` skill joins `evidence-led-ui` without changing when either specialist is invoked.",
    ],
  },
  {
    version: "0.1.61",
    date: "2026-08-07",
    items: [
      "Desktop sessions became truly shared without becoming interchangeable. Each window keeps its own conversation and editable tab name while one daemon handles the heavy lifting.",
      "Window controls learned your whole workspace: multi-monitor tiling, duplicate-title prevention, and persistent layouts now keep every active session easy to find.",
      "Goal runs, task reconciliation, MiMo routing, Pixel tooling, and the bundled `evidence-led-ui` workflow now travel together in the EZ Coder release track.",
    ],
  },
];

/**
 * Return the newest changelog bullets, capped across versions while preserving
 * version grouping.
 */
export function recentChangelog(maxItems = 50): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let count = 0;
  for (const entry of CHANGELOG) {
    if (count >= maxItems) break;
    const items = entry.items.slice(0, maxItems - count);
    if (items.length === 0) break;
    entries.push({ ...entry, items });
    count += items.length;
  }
  return entries;
}
