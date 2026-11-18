# Upstream picks (KenKaiii/gg-framework → ezcoder)

Status of the take/skip plan made on 2026-11-17 for upstream up to e8d8c9ab (v0.114.0).

`origin/main` already holds upstream up to **ab961083 (v0.109, 2026-11-10)**: the
"Sync upstream v0.109 (keep our sign-ins and UI)" merge (#39). Every planned
commit dated before then was checked line by line against `origin/main` (added
lines with names mapped to ours). "In v0.109 sync" below means that check found
the change already present, so no port was needed.

Ports live on branch `upstream-picks` (PR #45) as `Port upstream <sha>: …` commits.

## Taken

| Upstream                     | What                                                   | Where                     |
| ---------------------------- | ------------------------------------------------------ | ------------------------- |
| 95615bde                     | Stall watchdog counts SSE pings                        | In v0.109 sync            |
| c73b1866                     | Engine speed/cost pass                                 | In v0.109 sync            |
| 856bf0eb                     | Restored Anthropic sessions with web search → HTTP 400 | In v0.109 sync            |
| cf6c9a23                     | Web search/fetch/local-model context cost              | In v0.109 sync            |
| a4bb110c                     | Steroids tool guidance                                 | In v0.109 sync            |
| c86b56db                     | Anthropic SDK 1.4, openai 7.50                         | In v0.109 sync            |
| 85cb0ef7                     | File lock race                                         | In v0.109 sync            |
| 88c1bec0                     | Plan progress stuck at 0                               | In v0.109 sync            |
| 57de6b6f                     | "Awaiting the user's next message" filler              | In v0.109 sync            |
| 5315a8a2                     | Stale threat-feed cache                                | In v0.109 sync            |
| a2ca7720                     | OAuth user agent tracks live Claude Code version       | In v0.109 sync            |
| 0a9d083f                     | MiniMax M3.1 Flash                                     | In v0.109 sync            |
| 4900c197                     | Claude Fable 5.2                                       | In v0.109 sync            |
| 64fecfee                     | GPT Image GIFs, Codex client, Windows EPERM            | In v0.109 sync            |
| 5d340fa3, 8627ee65, 8020944e | Local-model fixes                                      | In v0.109 sync            |
| adea7972                     | `!` terminal commands                                  | In v0.109 sync            |
| a1c4f642                     | Chat attachments (large files, PDF/EPUB)               | In v0.109 sync            |
| 9403d456                     | macOS 27 AppKit crash                                  | In v0.109 sync            |
| a499dd49                     | "Set a workspace folder first"                         | In v0.109 sync            |
| 0954bed4                     | Vite dev dep scan                                      | In v0.109 sync            |
| b8627c2d, 0ba57296           | Test flake fixes                                       | In v0.109 sync            |
| 46c24a75                     | Release builds off macos-14                            | In v0.109 sync            |
| e7cf1bcd                     | "Update failed" with Retry / Download manually         | In v0.109 sync (our UI)   |
| 6e5eb4fc                     | Run-all task sweep race                                | `upstream-picks` e8ea53df |
| ec684b8b                     | OpenCode Go / pay-as-you-go                            | `upstream-picks` 4f9567de |
| fec81933                     | onnxruntime pruning (partial, see below)               | `upstream-picks` 0b5f5517 |
| 41754164                     | Web entry point, `guardUrl` on `web_fetch` redirects   | `upstream-picks` 7f51d474 |
| 4218d37d, 42056a36, 4fda58c6 | Windows/macOS CI flake fixes                           | `upstream-picks`          |
| 476f199d                     | MCP shell commands, add/remove folder routes           | `upstream-picks` 969d39ae |
| 9814207d                     | Stalled summaries, log trimming, Claude Code resume    | `upstream-picks` 094069d3 |
| 188a0caf                     | Local endpoints: pinned images, llama.cpp vision       | `upstream-picks` 0172acc1 |
| 6d7297ca                     | Autopilot answers for ask_user, slim /init             | `upstream-picks` aaf5c90e |
| 9b4a191f                     | Live Preview (panel rebuilt in our UI)                 | `upstream-picks` 290a17e3 |
| 58013cac                     | Dead-code removal (partial, see below)                 | `upstream-picks` ce3a0a0a |

## Partial picks

- **705af903** (GG Royale, pixel-art home, hedged streaming, skills refresh): only
  hedged streaming is in, via the v0.109 sync (`packages/agent/src/hedged-stream.ts`,
  `agent-loop.ts`). No Royale screen, `royale.rs`, Royale tests, pixel-art
  components or fonts exist in the tree. Its two generator scripts
  (`gen-home-title.py`, `gen-pixel-font.py`) came in with the sync but their
  outputs don't exist here, so ce3a0a0a removes them.
- **402e99d6**: "messages interrupt running tools" is in the v0.109 sync. Its
  Claude Code dialog test (`auth-routes.test.ts`) isn't, because it targets
  upstream's newer sign-in dialog.
- **1c91814c**: Grok 426 fix, compact routine bash output and Gemini hiding are
  all in the v0.109 sync.
- **5d0cb2ca**: per-mode skills are in the v0.109 sync (under `.ezcoder/skills`).
  The UI parts were dropped.
- **fec81933**: took the onnxruntime pruning for every napi ABI, plus the test
  helpers that skip when files are missing. Skipped the per-platform
  `sidecar:deps` size gate (it needs new baselines) and the CONTRIBUTING and
  dependency moves.
- **58013cac**: removed the plugin install chain (app wrappers, Tauri commands,
  sidecar routes and `plugin-bundles` install/list/remove all had no caller),
  `motion-review-gate`, unused motion-review schemas, about 25 unused exports,
  and unreferenced files (`tauri.svg`, `exp.mp3`, effects-geometry check).
  Skipped where the fork still uses the code:
  - `metal-fx` dependency, patch and config: used by `ActionMetal.tsx`
  - `@bokuweb/zstd-wasm`: used by `providers/openai-codex.ts`
  - `cycleThinking` / `agent_cycle_thinking`: used by `AppFooter.tsx`
  - `AsciiLogo` and its CSS: used by `HomeScreen.tsx` and `installer/dmg.html`
  - `goal-map-cozy`, `goal-map-props`, `goal-world-font` and `whatsnew-content`
    edits: `goal-map-mockups.ts`, `goal-farm-render.ts` and `WhatsNewCampfire.tsx`
    import the removed exports
  - the cli README screenshot: still linked from the README
- **c3a3e3c6** (unreferenced ggcoder modules): 11 of its 13 files were already
  gone in the v0.109 sync. Kept `core/source-maps.ts` and
  `@jridgewell/trace-mapping`, because `core/pixel-fix.ts` still imports them.

## Dropped

- **16913f9e** ChatGPT `invalid_grant` retry: it patches upstream's
  `loginChatGPT`/`exchangeCode` sign-in. We kept our own `loginOpenAI` flow, so
  the fix has nothing to apply to.
- `gg-guide` skill (in 476f199d, 6d7297ca and 9b4a191f): it documents upstream's
  desktop UI, which we replace.
- Claude Code route rewrite: 5092ebc2, f5d115b0, 1ff2c148, 488d9b20, 538741d3,
  d2abf696, c6b1f904, d5e84b86, 9f3574a4.
- GG World / Royale: 0ffded3e, c5db4fee, c6485c91, 8dc7656f, 494a43be, 06f447d7,
  26196d84, 0be67c25, b1bf36a9, 0dedfcaf, 3f652a8b, 38eb6d69, 71afe344, a549cb5b,
  c9d564b9, a17ea1eb.
- Commercial and distribution: 12da5c3a (AGPL), README/docs commits, 6414bf3f,
  91a549b9, 76056bc1, 6257da9c (Linux packaging), 550959a3, 352a404c, 40b26818,
  21df4a25, 1a3f0113, e91af327, 05f645d1, 74d1eaba, 70d17fa9, 5e2450c9, 0f24bd1f,
  137c3b6e.
- Fork-owned UI: d568c826, 762b970e, e6076b8c, 0d443e0f, 3774b4a1, 0e244624,
  2119baad, 22c5b1f7, 2a1fc166, 039a252c, fb1e29cc, c01a1bfb, bbdb8cb7, 1dc09471,
  c75fb92c.
- Skill trimming: 21adf945, 7302fa5a. We keep find-skills and task-list.
- Dependabot bumps: f051c4da, d3985812, d47016ee, ea8ce644, ab268b65, e9a49d96,
  d923c1cd, 00295ed1, 46efe2a7, 76dbe011, ede5b7ba, e8a11cf4. Take them when needed.

## Deferred

- None from the plan. Upstream commits after e8d8c9ab weren't reviewed.
