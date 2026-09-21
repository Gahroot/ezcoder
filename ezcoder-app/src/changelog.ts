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
    version: "0.70.0",
    date: "2026-09-21",
    items: [
      "Run twelve agents at once. The new `12 windows` layout keeps six on screen where you can actually read them and parks the other six on a second page, so nothing shrinks into a useless sliver. Tap `Cmd/Ctrl+1` and `Cmd/Ctrl+2` to flip between the pages, or pick one straight from the layout menu.",
      "Windows users, your branch list stays clean now. When a project copy got deleted out from under me, its branch used to linger forever with nothing attached to it. I match those leftovers to their owners properly, so they get cleared away like they always should have.",
    ],
  },
  {
    version: "0.69.0",
    date: "2026-09-20",
    items: [
      "The status line stopped being vague and started telling you the truth. Instead of a cheerful sign-off on everything, you now see what actually happened: `Checks passed`, `Checks failed`, `Verification incomplete`, or `Your decision needed`. When something was written but never proven, it says so plainly instead of letting you assume it works.",
      "My review no longer stacks a second bar under your task. It runs in the same row you are already watching, so a long review reads as one calm line instead of two spinners fighting for space, and the tokens it spends are counted in with the rest of the task.",
      "I got harder to fool about the word done. A green build is no longer enough for me to call your request finished. I check the work against what you actually asked for, including what happens when things fail or get cancelled, and when I find gaps I hand them all over at once instead of letting you discover them by asking if it is done five times.",
      "Slash commands now respect the words you type after them. Your own wording no longer gets thrown away in favour of the command's built-in text, so a command plus your instructions does what you actually wrote.",
    ],
  },
  {
    version: "0.68.0",
    date: "2026-09-20",
    items: [
      "Open the same project in a second window and it now gets its own private copy on its own branch, so two agents can never scribble over each other. The best part is you never clean up after it. The moment a copy has nothing left in it, it vanishes on its own. Anything still holding unsaved or unmerged work stays right where it is and tells you exactly what it is guarding.",
      "Your agents can finally work in parallel for real. Hand a subagent `isolate` and it gets a whole copy of your repo to tear through, free to touch any file it needs. If it commits, you keep the branch. If it does not, the copy disappears like it was never there.",
      "Every spare copy is now visible in one place. The project picker lists what each one is holding in plain words, like `2 unsaved files`, and clears out the empty ones in a single click. Nothing with real work inside it ever goes without you saying so twice.",
    ],
  },
  {
    version: "0.67.0",
    date: "2026-09-19",
    items: [
      "Long conversations no longer make you wait. EZ Coder now tidies its own memory in the background the moment a reply lands, so the pause you used to hit mid chat is gone and your next question starts instantly.",
      "The deep thinkers stopped overthinking. `GPT-6 Astra` and the `GPT-5.6` family now start at the effort their makers intended instead of pinned at the ceiling, and they answer in tighter prose. First replies come back dramatically faster and burn far less of your usage.",
      "Planning is quick again. `Plan mode` is read only exploring, so I capped its reasoning at `medium`. You get your plan in a fraction of the time with none of the quality lost.",
    ],
  },
  {
    version: "0.66.1",
    date: "2026-09-16",
    items: [
      "EZ Coder feels more alive while it works. I added `thinking orbs`, animated working beams, and polished metallic controls without weighing down startup.",
      "Long sessions stay focused and easier to understand. Use `/compact` to preserve the topics you care about, or `/diagnose` to see what a session is doing.",
      "Edits and final checks are more dependable. I hardened repeated replacements, carried failing tests through summaries, and made verification evidence survive complicated runs.",
      "A new `refactoring skill` helps EZ reshape code safely with behavior-preserving, test-guarded steps.",
    ],
  },
  {
    version: "0.3.0",
    date: "2026-09-10",
    items: [
      "Image generation just leveled up. I moved you onto `GPT Image 2.5` so the pictures EZ makes come back sharper, cleaner, and closer to what you asked for.",
      "The `Prompt Enhancer` now protects your intent. It keeps every detail you spelled out instead of smoothing your request into something generic.",
      "Finishing work is more trustworthy. I fixed the order of the final checks so EZ verifies its work properly before telling you a job is done.",
      "Dev servers start smoother. EZ waits until your server is genuinely ready instead of jumping the gun, so previews stop failing for no reason.",
      "The engine got lighter. I trimmed dead weight out of the download so installs and updates land faster.",
    ],
  },
  {
    version: "0.2.1",
    date: "2026-09-08",
    items: [
      "Your workspace now shows `GitHub CI status`, so you can see whether your latest checks passed without leaving EZ Coder.",
      "I tightened `completion checks`: fresh test evidence and an independent review help catch unfinished work before EZ calls it done.",
      "EZ can now recognize when it is `going in circles`, even when each attempt looks different, and pause to rethink its approach.",
      "Optional screens now use `on-demand loading`, keeping more code out of the app's initial load.",
    ],
  },
  {
    version: "0.1.69",
    date: "2026-09-05",
    items: [
      "Meet `GPT-6 Astra`, with deeper thinking and a massive context window. I tuned every limit so your longest, toughest builds stay sharp.",
      "Long-running work is steadier now. I fixed background tasks, process cleanup, and compaction edge cases that could stall or crash a session.",
      "The `Prompt Enhancer` now handles rich instructions cleanly, so your polished prompts arrive intact and ready to run.",
      "Big conversations stay smooth. I cut wasteful processing and tightened oversized prompts so EZ Coder keeps moving without cooking your machine.",
    ],
  },
  {
    version: "0.1.68",
    date: "2026-09-02",
    items: [
      "I fixed the `window arranger` menu so every layout and display option receives clicks again, even when the menu overlaps your transcript.",
    ],
  },
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
