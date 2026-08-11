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
