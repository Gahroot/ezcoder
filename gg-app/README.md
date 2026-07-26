# GG Coder — desktop app

The Tauri 2 desktop app: a React 19 + Vite webview shell over the full ggcoder agent.
This is the product we ship; the CLI is the same engine without the face.

**Download it:** [latest release](https://github.com/KenKaiii/gg-framework/releases/latest)
(macOS Apple Silicon `.dmg`, Windows `.exe`). Feature tour lives in the
[root README](../README.md).

## Develop

```bash
pnpm install                              # from the repo root
pnpm --filter @kenkaiiii/ggcoder build    # build the sidecar first
pnpm --filter gg-app tauri dev
```

Webview edits hot-reload through Vite. **Restart the app** after Rust or sidecar changes,
and rebuild `@kenkaiiii/ggcoder` whenever you touch `packages/ggcoder/src/app-sidecar.ts`.

```bash
pnpm --filter gg-app check    # tsc --noEmit
pnpm --filter gg-app test     # vitest
pnpm --filter gg-app lint
```

## Architecture

Each window runs its **own** Node agent sidecar bound to its **own** project cwd — separate
agents, separate projects, fully isolated. Multiple windows = multiple projects open at once.

```
React webview ──invoke()──▶ Rust commands ──HTTP──▶ Node sidecar (AgentSession)
     ▲                          │                         │
     └────── emit_to(window) ◀──┴──── SSE /events ◀────────┘
```

- **`src-tauri/src/lib.rs`** — Rust shell. Owns a sidecar registry keyed by window label;
  every command resolves the calling window's port, and SSE frames are re-emitted with
  `emit_to` so windows never see each other's events.
- **`src/agent.ts`** — the only bridge to Rust. All IPC wrappers live here; the webview
  never `fetch`es the sidecar directly (mixed content is blocked on the `tauri://` origin).
- **`packages/ggcoder/src/app-sidecar.ts`** — HTTP + SSE seam over `AgentSession`.

New IPC = a Rust `#[tauri::command]` proxying the sidecar, registered in `invoke_handler!`,
plus a typed wrapper in `agent.ts`.

## Rules

- The agent spine (gg-ai → gg-agent → gg-core → `AgentSession`) is reused **verbatim** —
  never fork agent logic into the app.
- App-only concerns (windows, IPC, picker, settings) live here; anything provider- or
  agent-coupled stays in its package and the app consumes it.
- One component per file, mirroring the TUI's look.

## README screenshots

`scripts/capture-screenshots.mjs` regenerates `docs/screenshots/*.png` for the root README.

```bash
pnpm --filter gg-app dev                  # terminal 1
node gg-app/scripts/capture-screenshots.mjs
```

It drives the webview in headless Chromium with a **fake `window.__TAURI_INTERNALS__`**, so
every screen renders from the synthetic demo data at the top of that script. No real
sessions, project paths, chat content, tokens, or account names can reach a committed
image — keep it that way when you add a shot. Capture only noteworthy screens, not a tour.

The footer model picker is deliberately absent: on macOS it's a native `<select>` popup,
which is an OS-level window Chromium can't capture.

## Shipping

Packaging (bundled per-platform Node runtime, single-file esbuild sidecar, externals,
signing/notarization) → [DISTRIBUTION.md](DISTRIBUTION.md). Releases fire from a `v*` git
tag; version bumps go through `pnpm --filter gg-app bump`, never by hand.

Debug log: `~/.gg/gg-app-sidecar.log` (each window's sidecar appends, tagged with its `sid=`).
