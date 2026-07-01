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

### Architecture: one shared daemon, per-window sessions

All windows share **one** Node agent daemon (`packages/cli/src/app-sidecar.ts`); each window
owns its own `AgentSession` *inside* that daemon, addressed by a session id and bound to its
own project cwd — separate agents, separate projects, still fully isolated. This is the core
model: multiple windows = multiple projects open at once (one could be ezcoder, another
Claude Code, another Codex). The daemon hands back a session id from `POST /session`; the Rust
shell attaches it as the `x-gg-session` header on every proxy request to route to the right
window's session (one daemon process replaced the old per-window-sidecar model).

```
React webview ──invoke()──▶ Rust commands ──HTTP (x-gg-session)──▶ shared Node daemon
     ▲                          │                                    │  (AgentSession per window)
     └────── emit_to(window) ◀──┴──── SSE /events ◀───────────────────┘
```

- **`ezcoder-app/src-tauri/src/lib.rs`** — Rust shell. Owns the single shared daemon plus a
  per-window session registry keyed by window label (`main`, `project-1`, …). Every command
  (`agent_prompt`, `agent_state`, `select_project`, …) hits the shared daemon port via
  `port_for(&webview)` and routes to the calling window's session via `session_for` (the
  `x-gg-session` header). SSE frames are re-emitted with `emit_to(webview_window(label))` so
  **windows never see each other's events**. Window background is painted `#111317` before first
  frame (no white flash). New windows are tiled like macOS fill&arrange (`setup_windows` →
  `arrange_windows`, 2-up halves / 4-up quads).
- **`ezcoder-app/src/agent.ts`** — the ONLY bridge to Rust. Listens on the **current** webview target
  (`getCurrentWebviewWindow().listen`) — a global `listen` would miss window-scoped events. All
  IPC wrappers (`sendPrompt`, `listProjects`, `selectProject`, `createProject`, …) live here.
- **`app-sidecar.ts`** — HTTP+SSE daemon over `AgentSession`. Session lifecycle: `POST /session`
  (create, returns the id) / `DELETE /session/:id` (dispose); per-session endpoints `/state`,
  `/events`, `/prompt`, `/cancel`, `/thinking`, `/model(s)`, `/commands`, `/projects`, `/sessions`,
  `/settings`, `/create-project`, selected by the `x-gg-session` header. Slash-command expansion
  is delegated to `AgentSession.prompt()` (single source of truth — built-in + `.ezcoder/commands`
  custom). Env: `GG_APP_CWD` (project root), `GG_APP_PORT` (0 = ephemeral), `GG_APP_SESSION_ID`
  (resume a session file).

### UI components (`ezcoder-app/src/`)

One component per file; mirror the TUI's look. Reusable primitives: `Modal`, `BackButton`
(chevron), `Badge` + `sourceStyle` (ezcoder=blue, Claude Code=clay `#d97757`, Codex=green
`#10a37f`). Key screens/controls: `ProjectPicker` (shown per window on load — lists discovered
projects + their recent 5 sessions, New Project, Settings), `NewProjectModal`,
`SettingsModal` (projects-root folder), `ModelMenu`, `SlashMenu`, `LiveToolPanel`,
`ActivityBar` (spinner + thinking timer + tokens), `PlanModeLogo` (amber ASCII banner),
`WindowLayoutButton` (2/4 tiling), `Markdown`. Theme mirrors `ui/theme/dark.json` in `theme.ts`.

### Error display (gg-app)

gg-app never shows a raw provider string (e.g. `400 {"code":"400",...}`) — every error is run
through gg-ai's `formatError` server-side before it reaches the webview, mirroring the TUI's
headline/message/guidance split ("is this me or them", and — for usage-limit stops — when it
resets).

- **Root cause of the raw-JSON blob**: the OpenAI and Anthropic SDKs both build `err.message` by
  `JSON.stringify`-ing the whole error body whenever the provider's response has no usable string
  `message` (e.g. Xiaomi MiMo returning `{"code":"400","message":"","param":"","type":""}`) — so
  the blob was baked into `err.message` before it ever reached gg-ai's formatting layer.
  `isRawJsonErrorEcho` / `emptyProviderErrorMessage` in `packages/gg-ai/src/errors.ts` detect that
  shape and swap in a clean "provider returned an empty error response" fallback; both provider
  `toError()`s (`providers/openai.ts`, `providers/anthropic.ts`) apply it before constructing the
  `ProviderError`. The raw body is never lost — the original thrown error is kept on `cause` for
  any in-process debugging/rethrow, even though the log line and the UI only ever show the clean
  fallback.

- **`app-sidecar.ts`** has one chokepoint, `broadcastError(type, logLabel, err)`, used by every
  catch site that used to hand-roll `{ message: err.message }` (the session/Ken event-bus `error`
  handlers, `runAgent`'s catch, Ken's turn runner). It calls `formatError`, logs the full
  structured detail to `gg-app-sidecar.log`, and broadcasts `{ headline, message?, guidance,
  provider?, statusCode?, resetsAt? }` under the `"error"` / `"ken_error"` SSE type. Add new
  error catch sites through this helper — never broadcast a bare message again.
- **Webview**: the `Item` union's `error` variant carries `headline` / `message` / `guidance`
  (a legacy `text` fallback remains for any older flat-string frame). `useAgentEvents.ts` and
  `useKenMentor.ts` map the SSE payload onto it; `TranscriptRow` in `App.tsx` renders headline
  (bold, error color) + message + guidance as stacked dim sub-lines — no new CSS, reuses the
  existing `.line.error` row and `theme.error`/`theme.textDim` tokens.

### Project discovery + app settings

- **Discovery** lives in `packages/cli/src/core/project-discovery.ts` (one home — gg-boss
  re-exports it). `discoverProjects()` scans ezcoder + Claude Code + Codex session stores;
  `listRecentSessions(cwd)` fast-paths the newest 5 ezcoder sessions (mtime sort → single-pass
  parse, no full-store scan). Decoded ezcoder paths are `path.resolve`d so traversal segments
  don't surface as a stray `..` project.
- **App settings** are app-specific in `~/.ezcoder/ezcoder-app.json` (separate from the CLI's
  `~/.ezcoder/settings.json`). Currently `projectsRoot` — the folder new projects are created inside
  (default `~/ez-projects`). New projects: name validated to `^[a-z0-9]+(?:-[a-z0-9]+)*$`, folder
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

## Releasing

There are **two independent release tracks**. The `/release` command (project-local,
lives in `.ezcoder/commands/release.md`) orchestrates both in the correct order — prefer it
over running the steps by hand.

- **Track A — npm framework packages** (`@prestyj/ai`, `gg-agent`, `gg-core`,
  `ezcoder`, `gg-boss`, + dependents) via **Changesets**. This is the CLI engine.
- **Track B — ezcoder-app desktop** (`ezcoder-app`, the `0.1.x` line, `private: true`, never on
  npm). Released by pushing a `v*` git tag, which fires
  `.github/workflows/release.yml` to build/sign/notarize installers and publish a
  **non-draft** GitHub release + updater `latest.json`.

### How ezcoder-app consumes the packages

ezcoder-app does **not** depend on the published npm versions. Its CI runs
`pnpm install --frozen-lockfile` (resolving `workspace:*` locally), builds gg-ai →
gg-agent → ezcoder **from source**, then bundles `packages/cli/dist/app-sidecar.js`
into the Tauri app. So a desktop release ships whatever is in the workspace at tag time —
npm need not be published first for the app to build. Still, publish npm first (Track A
then Track B) so the shipped CLI and app stay in lockstep.

### Track A — npm packages (Changesets)

Manual multi-package version bumping is gone — do **not** hand-edit package `version`
fields. The framework spine — `@prestyj/ai`, `@prestyj/agent`,
`@prestyj/core`, `@prestyj/cli`, `@prestyj/boss` — is a **fixed group**
in `.changeset/config.json`: a changeset touching any one bumps them all to the same
version together (this is what kept drifting before). Dependents like gg-editor /
gg-voice get an automatic patch bump.

```bash
pnpm changeset            # describe the change; pick bump level (patch/minor/major)
pnpm changeset version    # apply bumps + update internal deps + write changelogs
pnpm build                # rebuild with the new versions
git commit -am "Version packages"   # COMMIT BEFORE PUBLISH — publish tags HEAD
pnpm changeset publish    # publishes in topological order + creates git tags
git push --follow-tags    # push the version commit + the new tags
```

Commit the version bump **before** `pnpm changeset publish` — publish creates git tags
at `HEAD`, so an uncommitted bump tags the wrong commit and publishes from a dirty tree.
`pnpm changeset status` shows the pending release graph at any time.

### Track B — ezcoder-app desktop (tag-triggered)

The desktop version lives in **four files that must stay in lockstep**:
`ezcoder-app/package.json`, `ezcoder-app/src-tauri/tauri.conf.json`, `ezcoder-app/src-tauri/Cargo.toml`,
and `ezcoder-app/src-tauri/Cargo.lock`. **Never hand-edit them** — use the helper, which
bumps all four at once and prints the new version:

```bash
pnpm --filter ezcoder-app bump <patch|minor|major|x.y.z>   # scripts/bump-version.mjs
git add ezcoder-app/package.json ezcoder-app/src-tauri/tauri.conf.json \
        ezcoder-app/src-tauri/Cargo.toml ezcoder-app/src-tauri/Cargo.lock
git commit -m "Update ezcoder-app to v<NEW>"
git push
git tag v<NEW> && git push origin v<NEW>   # fires release.yml
gh run list --workflow=release.yml --limit 1   # confirm the build kicked off
```

The workflow has `releaseDraft: false` — it publishes a **live, non-draft** release
automatically when the build finishes; there is no manual publish step. It builds for
macOS (arm64) + Windows only (Linux/Intel-mac legs are intentionally omitted — see the
comments in `release.yml`).

### npm auth (Track A)

- npm granular access token must be set: `npm set //registry.npmjs.org/:_authToken=<token>`
- `access: public` is set in `.changeset/config.json` (and each package's `publishConfig`), required for scoped packages.
- `workspace:*` references resolve to real versions at publish time because changesets publishes via pnpm.

### Verify a published npm release (Track A)

```bash
npm view @prestyj/cli versions --json   # check published versions
npm i -g @prestyj/cli@<version>         # test install
ezcoder --help                          # verify CLI works
```

If `npm i` gets ETARGET after publishing, clear cache: `npm cache clean --force`

## Architecture notes (project-specific)

- **Auth/config**: OAuth-only (no API keys), PKCE flows in `cli/src/core/oauth/`; tokens + all config under `~/.ezcoder/`. Debug log at `~/.ezcoder/debug.log`, truncated each CLI restart (singleton in `core/logger.ts`).
- **Goal subsystem** is first-class, split across `cli/src/core/goal-*`, `cli/src/ui/goal-*`, `cli/src/tools/goals.ts`, `scripts/goal-deep-audit/`.
- **MCP** connects **once at startup** (`connectInitialMcpTools` in `cli.ts`) — adding a server mid-session needs a restart. Scope files: global `~/.ezcoder/mcp.json`, project `./.ezcoder/mcp.json` (code: `core/mcp/store.ts:53` — the project comment in that file saying `.gg/mcp.json` is stale). Project wins on name collision; provider defaults (`kencode-search`) can't be overridden. `add` grammar mirrors `claude mcp add`. WebSocket transport is parsed but rejected; `${VAR}` expansion is not done.
- **Pixel fix flow** swaps cwd mid-session: `startPixelFix` in `ui/App.tsx` must do all of `process.chdir`, `rebuildToolsForCwd` (tools bake cwd at creation), rebuild the system prompt into `messagesRef.current[0]`, and bump `staticKey` — chdir alone is not enough, and project-scoped MCP servers do NOT follow this swap.
- **Slash commands** are two systems: UI commands needing React state live inline in `handleSubmit` in `ui/App.tsx`; the rest live in `createBuiltinCommands()` in `core/slash-commands.ts`. `/model`, `/compact`, `/quit` exist in both — the App.tsx handler wins (checked first). Prompt-template commands load from `.ezcoder/commands/`.

## Upstream sync

`./scripts/sync-upstream.sh` (`--dry-run` to preview) fetches + merges `upstream/main`, then rewrites fork-specific identity: dirs `gg-ai→ai`, `gg-agent→agent`, `ezcoder→cli`; scope `@kenkaiiii→@prestyj`; branding `GG→EZ`, `~/.ezcoder/`, `EZCoderAIError`. On merge conflicts: resolve, `git merge --continue`, re-run the script. The EZ block-art logo in `Banner.tsx`/`cli.ts` can't be auto-detected — verify visually with `ezcoder --help` after syncing.
