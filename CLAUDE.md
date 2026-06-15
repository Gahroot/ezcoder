# ezcoder

pnpm monorepo (ESM, TypeScript) for an AI coding-agent toolchain published under the `@prestyj/*` npm scope. Foundation is `@prestyj/ai`; everything LLM-facing builds up `ai → agent → cli → (editor, boss)`. The `pixel-*` family is a separate multi-language error-tracking product. Repo is a fork of `KenKaiii/ezcoder`.

Workspace globs (`pnpm-workspace.yaml`): `packages/*`, `Matey`, `experiments/*`.

## Packages (`packages/`)

| Dir | npm name | bin | Owns |
|---|---|---|---|
| `ai/` | `@prestyj/ai` | — | Unified LLM streaming over Anthropic + OpenAI SDKs (`stream`, `providerRegistry`, `src/providers/`) |
| `agent/` | `@prestyj/agent` | — | Agentic loop + tool execution (`Agent`, `AgentStream`, `agentLoop`) |
| `cli/` | `@prestyj/cli` | `ezcoder` | Main interactive coding-agent TUI (Ink/React). Largest package |
| `boss/` | `@prestyj/boss` | `ezboss` | Multi-worker orchestrator across projects (flat `src/`, ~70 files) |
| `editor/` | `@prestyj/editor` | `ezeditor` | Video-editing agent (DaVinci Resolve / Premiere; ffmpeg tools, skills) |
| `editor-premiere-panel/` | `@prestyj/editor-premiere-panel` | `ez-editor-premiere-panel` | Installer for an Adobe Premiere UXP/CEP panel |
| `eyes/` | `@prestyj/eyes` | `ezcoder-eyes` | Perception probes (screenshots/logs); writes `.ezcoder/eyes/` |
| `voice/` | `@prestyj/voice` | — | Realtime voice orchestration; bridges to `ezcoder-rpc` + `ezboss` |
| `pixel/` | `@prestyj/pixel` | `ez-pixel` | Error-tracking SDK (Node/browser/deno/workers) |
| `pixel-server/` | (private) | — | Cloudflare Workers + D1 ingest backend (Hono) |
| `pixel-{go,py,rb,rs,swift}/` | per-lang | — | Pixel SDK ports (Go, Python, Ruby, Rust, Swift) |

Workspace deps: `agent→ai`; `voice→agent,ai`; `cli→agent,ai,pixel`; `editor→agent,ai,cli`; `boss→agent,ai,cli` (devDeps). `pixel*` ports are independent.

Non-package dirs: `Matey/` (separate Electron + Vite + React app, own tsconfigs/eslint), `ruby/` (Ruby agent stack: `ez_agent`, `ez_agent-rails`, `ez_llm`), `experiments/prompt-bench/`, `scripts/`.

## Tech stack (from manifests)
## ezcoder-app — Desktop App (primary product)

`ezcoder-app/` is the **Tauri 2 desktop app** — a React 19 + Vite webview shell over the full
ezcoder agent. This is the main product we ship to users now; the CLI is the engine, the
app is the face. Reuse the agent spine unchanged — never fork agent logic into the app.

**Run**: `cd ezcoder-app && pnpm tauri dev` (rebuild `@prestyj/cli` first if you touched the
sidecar: `pnpm --filter @prestyj/cli build`). Restart the app after Rust/sidecar
changes; pure webview edits hot-reload via Vite HMR.

### Architecture: per-window sidecar

Each window runs its **own** Node agent sidecar (`packages/cli/src/app-sidecar.ts`) bound
to its **own project cwd** — separate agents, separate projects, fully isolated. This is the
core model: multiple windows = multiple projects open at once (one could be ezcoder, another
Claude Code, another Codex).

```
React webview ──invoke()──▶ Rust commands ──HTTP──▶ Node sidecar (AgentSession)
     ▲                          │                         │
     └────── emit_to(window) ◀──┴──── SSE /events ◀────────┘
```

- **`ezcoder-app/src-tauri/src/lib.rs`** — Rust shell. Owns a `Sidecars` registry keyed by window
  label (`main`, `project-1`, …). Each command (`agent_prompt`, `agent_state`, `select_project`,
  …) resolves the calling window's sidecar port via `port_for(&webview)`. SSE frames are
  re-emitted with `emit_to(webview_window(label))` so **windows never see each other's events**.
  Window background is painted `#111317` before first frame (no white flash). New windows are
  tiled like macOS fill&arrange (`setup_windows` → `arrange_windows`, 2-up halves / 4-up quads).
- **`ezcoder-app/src/agent.ts`** — the ONLY bridge to Rust. Listens on the **current** webview target
  (`getCurrentWebviewWindow().listen`) — a global `listen` would miss window-scoped events. All
  IPC wrappers (`sendPrompt`, `listProjects`, `selectProject`, `createProject`, …) live here.
- **`app-sidecar.ts`** — HTTP+SSE seam over `AgentSession`. Endpoints: `/state`, `/events`,
  `/prompt`, `/cancel`, `/thinking`, `/model(s)`, `/commands`, `/projects`, `/sessions`,
  `/settings`, `/create-project`. Slash-command expansion is delegated to `AgentSession.prompt()`
  (single source of truth — built-in + `.ezcoder/commands` custom). Env: `GG_APP_CWD` (project root),
  `GG_APP_PORT` (0 = ephemeral), `GG_APP_SESSION_ID` (resume a session file).

### UI components (`ezcoder-app/src/`)

One component per file; mirror the TUI's look. Reusable primitives: `Modal`, `BackButton`
(chevron), `Badge` + `sourceStyle` (ezcoder=blue, Claude Code=clay `#d97757`, Codex=green
`#10a37f`). Key screens/controls: `ProjectPicker` (shown per window on load — lists discovered
projects + their recent 5 sessions, New Project, Settings), `NewProjectModal`,
`SettingsModal` (projects-root folder), `ModelMenu`, `SlashMenu`, `LiveToolPanel`,
`ActivityBar` (spinner + thinking timer + tokens), `PlanModeLogo` (amber ASCII banner),
`WindowLayoutButton` (2/4 tiling), `Markdown`. Theme mirrors `ui/theme/dark.json` in `theme.ts`.

### Project discovery + app settings

- **Discovery** lives in `packages/cli/src/core/project-discovery.ts` (one home — gg-boss
  re-exports it). `discoverProjects()` scans ezcoder + Claude Code + Codex session stores;
  `listRecentSessions(cwd)` fast-paths the newest 5 ezcoder sessions (mtime sort → single-pass
  parse, no full-store scan). Decoded ezcoder paths are `path.resolve`d so traversal segments
  don't surface as a stray `..` project.
- **App settings** are app-specific in `~/.ezcoder/ezcoder-app.json` (separate from the CLI's
  `~/.ezcoder/settings.json`). Currently `projectsRoot` — the folder new projects are created inside
  (default `~/gg-projects`). New projects: name validated to `^[a-z0-9]+(?:-[a-z0-9]+)*$`, folder
  created under the root, then the window re-points at it via `select_project`.

### Rules

- The agent spine (gg-ai → gg-agent → gg-core → ezcoder `AgentSession`) is reused **verbatim**.
  App-only concerns (windows, IPC, picker, settings) live in `ezcoder-app/`; anything provider- or
  agent-coupled stays in its existing home and the app consumes it.
- New IPC = add a Rust `#[tauri::command]` that proxies the sidecar + register it in
  `invoke_handler!`, expose a typed wrapper in `agent.ts`, never `fetch` the sidecar from the
  webview (mixed-content blocked on the `tauri://` origin).
- Webview calls that hit the sidecar must `await waitForReady()` first (startup/respawn race).

## Project Structure

TypeScript `^6.0.3` · Vitest `^4.1` · ESLint `^10.2` flat config + typescript-eslint · Prettier `^3.8` (NOT Biome) · Ink 6/7 + React 19. Build: **tsup** for libs (`ai`, `agent`, `boss`, `pixel`, `voice`); raw **tsc** for `cli`, `editor`, `eyes`, `editor-premiere-panel`. No `packageManager` or `engines` field is pinned anywhere. `tsconfig.json`: ES2022, `moduleResolution: bundler`, strict, `verbatimModuleSyntax`. `.prettierrc`: 100 print width, 2-space, double quotes, trailing commas.

Note version skew: Matey pins ESLint `^9.39`; `ink` is **patched** (`patches/`, both 6.8.0 and 7.0.2) — relevant when touching TUI rendering.

## Commands

```bash
pnpm build        # pnpm -r build
pnpm check        # pnpm -r check (tsc --noEmit)
pnpm test         # pnpm -r test (vitest run)
pnpm lint         # eslint packages/*/src + Matey ; lint:fix to auto-fix
pnpm format       # prettier write ; format:check to verify
```

Per-package: `pnpm --filter @prestyj/<pkg> <build|check|test>`. `cli` adds `verify:goal:*` scripts (the goal subsystem test suite). `pixel-server` uses `wrangler dev|deploy` + `db:local|db:remote` (D1 migrations). `experiments/prompt-bench`: `pnpm bench`. Root `prepare` runs `pnpm build` on install.

## Publishing

Use `pnpm publish` (not `npm publish`) so `workspace:*` resolves. Bump the 3 core `package.json` versions in sync, build, then publish in dependency order with `--no-git-checks`:

```bash
pnpm --filter @prestyj/ai publish --no-git-checks
pnpm --filter @prestyj/agent publish --no-git-checks
pnpm --filter @prestyj/cli publish --no-git-checks
```

All scoped packages need `"publishConfig": { "access": "public" }`. If `npm i` gives ETARGET after publish: `npm cache clean --force`.

## Architecture notes (project-specific)

- **Auth/config**: OAuth-only (no API keys), PKCE flows in `cli/src/core/oauth/`; tokens + all config under `~/.ezcoder/`. Debug log at `~/.ezcoder/debug.log`, truncated each CLI restart (singleton in `core/logger.ts`).
- **Goal subsystem** is first-class, split across `cli/src/core/goal-*`, `cli/src/ui/goal-*`, `cli/src/tools/goals.ts`, `scripts/goal-deep-audit/`.
- **MCP** connects **once at startup** (`connectInitialMcpTools` in `cli.ts`) — adding a server mid-session needs a restart. Scope files: global `~/.ezcoder/mcp.json`, project `./.ezcoder/mcp.json` (code: `core/mcp/store.ts:53` — the project comment in that file saying `.gg/mcp.json` is stale). Project wins on name collision; provider defaults (`kencode-search`) can't be overridden. `add` grammar mirrors `claude mcp add`. WebSocket transport is parsed but rejected; `${VAR}` expansion is not done.
- **Pixel fix flow** swaps cwd mid-session: `startPixelFix` in `ui/App.tsx` must do all of `process.chdir`, `rebuildToolsForCwd` (tools bake cwd at creation), rebuild the system prompt into `messagesRef.current[0]`, and bump `staticKey` — chdir alone is not enough, and project-scoped MCP servers do NOT follow this swap.
- **Slash commands** are two systems: UI commands needing React state live inline in `handleSubmit` in `ui/App.tsx`; the rest live in `createBuiltinCommands()` in `core/slash-commands.ts`. `/model`, `/compact`, `/quit` exist in both — the App.tsx handler wins (checked first). Prompt-template commands load from `.ezcoder/commands/`.

## Upstream sync

`./scripts/sync-upstream.sh` (`--dry-run` to preview) fetches + merges `upstream/main`, then rewrites fork-specific identity: dirs `gg-ai→ai`, `gg-agent→agent`, `ezcoder→cli`; scope `@kenkaiiii→@prestyj`; branding `GG→EZ`, `~/.ezcoder/`, `EZCoderAIError`. On merge conflicts: resolve, `git merge --continue`, re-run the script. The EZ block-art logo in `Banner.tsx`/`cli.ts` can't be auto-detected — verify visually with `ezcoder --help` after syncing.
