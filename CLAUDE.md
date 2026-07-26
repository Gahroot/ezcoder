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

The MiniMax provider defaults to **MiniMax M3** (1M context, image + video). Video-capable
models are Gemini 3.x, Kimi K3/K2.7 Code, MiniMax M3, and Xiaomi **MiMo-V2.5** (the omnimodal model;
the coding-focused MiMo-V2.5-Pro is text-only) — these accept native video blocks (`VideoContent`).
MiMo-V2.5 rides the OpenAI-compatible transport: video/image are sent as base64 data URLs
(`video_url`/`image_url`), and its base64 payload cap is 50 MB (so the registry's `maxVideoBytes`
is ~36 MB raw to stay under it after base64 inflation). Video attachments are supported in the
chat input (drag, paste, or type a path); for non-video models the video is saved to a temp file
and the model is told to inspect it with ffmpeg/its tools (mirrors the GLM image fallback). The
`supportsVideo` capability flag lives in `packages/cli/src/core/model-registry.ts`.

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

### Error display (ezcoder-app)

ezcoder-app never shows a raw provider string (e.g. `400 {"code":"400",...}`) — every error is run
through gg-ai's `formatError` server-side before it reaches the webview, mirroring the TUI's
headline/message/guidance split ("is this me or them", and — for usage-limit stops — when it
resets).

- **Root cause of the raw-JSON blob**: the OpenAI and Anthropic SDKs both build `err.message` by
  `JSON.stringify`-ing the whole error body whenever the provider's response has no usable string
  `message` (e.g. Xiaomi MiMo returning `{"code":"400","message":"","param":"","type":""}`) — so
  the blob was baked into `err.message` before it ever reached gg-ai's formatting layer.
  `isRawJsonErrorEcho` / `emptyProviderErrorMessage` in `packages/ai/src/errors.ts` detect that
  shape and swap in a clean "provider returned an empty error response" fallback; both provider
  `toError()`s (`providers/openai.ts`, `providers/anthropic.ts`) apply it before constructing the
  `ProviderError`. The raw body is never lost — the original thrown error is kept on `cause` for
  any in-process debugging/rethrow, even though the log line and the UI only ever show the clean
  fallback.

- **`app-sidecar.ts`** has one chokepoint, `broadcastError(type, logLabel, err)`, used by every
  catch site that used to hand-roll `{ message: err.message }` (the session/Nolan event-bus `error`
  handlers, `runAgent`'s catch, Nolan's turn runner). It calls `formatError`, logs the full
  structured detail to `ezcoder-app-sidecar.log`, and broadcasts `{ headline, message?, guidance,
  provider?, statusCode?, resetsAt? }` under the `"error"` / `"nolan_error"` SSE type. Add new
  error catch sites through this helper — never broadcast a bare message again.
- **Webview**: the `Item` union's `error` variant carries `headline` / `message` / `guidance`
  (a legacy `text` fallback remains for any older flat-string frame). `useAgentEvents.ts` and
  `useNolanMentor.ts` map the SSE payload onto it; `TranscriptRow` in `App.tsx` renders headline
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
version together (this is what kept drifting before). Dependents like `@prestyj/editor` /
`@prestyj/voice` get an automatic patch bump.

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
- **MCP** connects **once at startup** (`connectInitialMcpTools` in `cli.ts`) — adding a server mid-session needs a restart. Scope files: global `~/.ezcoder/mcp.json`, project `./.ezcoder/mcp.json`. Project wins on name collision; provider defaults (`kencode-search`) can't be overridden. `add` grammar mirrors `claude mcp add`. WebSocket transport is parsed but rejected; `${VAR}` expansion is not done.
- **Pixel fix flow** swaps cwd mid-session: `startPixelFix` in `ui/App.tsx` must do all of `process.chdir`, `rebuildToolsForCwd` (tools bake cwd at creation), rebuild the system prompt into `messagesRef.current[0]`, and bump `staticKey` — chdir alone is not enough, and project-scoped MCP servers do NOT follow this swap.
- **Slash commands** are two systems: UI commands needing React state live inline in `handleSubmit` in `ui/App.tsx`; the rest live in `createBuiltinCommands()` in `core/slash-commands.ts`. `/model`, `/compact`, `/quit` exist in both — the App.tsx handler wins (checked first). Prompt-template commands load from `.ezcoder/commands/`.

## Upstream sync

`./scripts/sync-upstream.sh` (`--dry-run` to preview) fetches + merges `upstream/main`, then rewrites fork-specific identity: dirs `gg-ai→ai`, `gg-agent→agent`, `ezcoder→cli`; scope `@kenkaiiii→@prestyj`; branding `GG→EZ`, `~/.ezcoder/`, `EZCoderAIError`. On merge conflicts: resolve, `git merge --continue`, re-run the script. The EZ block-art logo in `Banner.tsx`/`cli.ts` can't be auto-detected — verify visually with `ezcoder --help` after syncing.

## Key Patterns

- **StreamResult/AgentStream**: dual-nature objects — async iterable (`for await`) + thenable (`await`)
- **EventStream**: push-based async iterable in `@prestyj/ai/utils/event-stream.ts`
- **agentLoop**: pure async generator — call LLM, yield deltas, execute tools, loop on tool_use
- **OAuth-only auth**: no API keys, PKCE OAuth flows, tokens in `~/.ezcoder/auth.json`
- **Zod schemas**: tool parameters defined with Zod, converted to JSON Schema at provider boundary
- **Debug logging**: the CLI and the app sidecar log to **different files** — always check the right one.
  - CLI (`ezcoder` in a terminal): `~/.ezcoder/debug.log` — truncated on each CLI restart.
  - **ezcoder-app (desktop app) — the one we actually use now**: `~/.ezcoder/ezcoder-app-sidecar.log`. Each window's
    sidecar process appends here (not truncated per-window), tagged with its own `sid=`. Same format:
    timestamped, category-tagged (`[app-sidecar]`, `[tool]`, `[cache]`, `[compaction]`, `[subagent]`,
    `[lsp]`, `[mcp]`, `[auth]`, …). Agent/provider errors land as `[ERROR] [app-sidecar] run failed
    message=…` or `[ERROR] [app-sidecar] agent error message=…`. Both files share the core file-writer
    logger (`openLog`/`log` in `@prestyj/core`, rotated at 10MB to a single `.1` generation);
    ezcoder's thin wrapper is `src/core/logger.ts` (`initLogger`, `attachToEventBus`). The sidecar wires
    its own bus listeners directly in `app-sidecar.ts` instead of calling `attachToEventBus`.

## LSP Inline Edit Diagnostics

Successful `edit`/`write` tool results get compiler-grade error diagnostics appended
(`Diagnostics in src/a.ts (informational …): L42:7 Type 'string' is not assignable …`)
so the model self-corrects type errors in the same turn it creates them. Code lives in
`packages/cli/src/core/lsp/` (`jsonrpc.ts` zero-dep Content-Length framing,
`servers.ts` catalog + root detection, `client.ts` document sync + push/pull race,
`manager.ts` lazy pool, `format.ts` rendering).

Hard rules:

- **TS/JS works for every user out of the box.** `typescript-language-server` + `typescript`
  ship as ezcoder dependencies (~26MB unpacked) — no postinstall, no downloads, no runtime
  `npx -y`. Resolution order: project's `node_modules` (walking up, its own TS version wins) →
  ezcoder's bundled copy → PATH. Node-based servers spawn via `process.execPath` + the real
  bin script (never `.bin` shims, which need `node` on PATH). Other servers
  (`pyright-langserver`, `gopls`, `rust-analyzer`, `clangd`) resolve from project/PATH only —
  they ship with their language toolchains.
- **Silent graceful degradation.** Missing/crashed/slow server ⇒ tool output is byte-identical
  to before (debug-log only). A failed spawn marks `(server, root)` broken for the session.
- **Lazy + budgeted.** Nothing spawns until the first edit of a matching file; diagnostics are
  capped at 3s warm / 8s first-touch — overruns return nothing and leave the server warm.
- **Errors only, capped at 5**, framed as informational so multi-file sequences aren't derailed.
- Opt out with `"lspDiagnostics": false` in `~/.ezcoder/settings.json`. Exit handlers call
  `lspManager.shutdownAll()` alongside `processManager`.
- Tests: `src/core/lsp/*.test.ts` run against a fake stdio server fixture
  (`src/tools/__fixtures__/fake-lsp-server.mjs`) — CI never needs real language servers.
  Opt-in real-tsserver test: `GG_LSP_INTEGRATION=1 npx vitest run src/core/lsp/integration.test.ts`.

## MCP Servers

`ezcoder mcp` adds and manages Model Context Protocol servers. Configs are stored in the same `{ "mcpServers": { … } }` shape Claude Code uses, so they're portable both directions.

### Scopes & file locations

- **Global** → `~/.ezcoder/mcp.json` — available in all EZ Coder sessions.
- **Project** → `./.ezcoder/mcp.json` — only the current project root.
- On a name collision, **project wins**. Provider defaults (e.g. `kencode-search`) stay authoritative — a user server can only add a new name, never override a default.

### Commands

```bash
ezcoder mcp                              # interactive dashboard (🟢/🔴 status, tool counts, scope)
ezcoder mcp list                         # list servers with live connection status
ezcoder mcp get <name>                   # show one server's config (secrets masked)
ezcoder mcp add <args…>                  # add a server (claude-compatible grammar)
ezcoder mcp remove <name> [--scope s]    # remove a server
```

The `add` grammar mirrors `claude mcp add` 1:1 — you can paste a `claude mcp add …` (or `ezcoder mcp add …`) line and the prefix is stripped automatically:

```bash
ezcoder mcp add --transport http notion https://mcp.notion.com/mcp
ezcoder mcp add --transport sse asana https://mcp.asana.com/sse
ezcoder mcp add --env AIRTABLE_API_KEY=key airtable -- npx -y airtable-mcp-server
```

`--scope user` maps to global; `local`/`project` map to project. Code lives in `core/mcp/` (`store.ts` persistence, `parse-add-command.ts` parser, `client.ts` `connectAllDetailed`/`probe`) and `cli/mcp.ts` + `ui/mcp.tsx`.

### Caveats

- **Connection is startup-only.** MCP connects once at launch (`connectInitialMcpTools` in `cli.ts`). Adding a server via `ezcoder mcp` mid-session won't hot-load it — restart ezcoder.
- **WebSocket transport** is parsed but rejected (no WS client today).
- **Env var expansion** (`${VAR}`) in `.mcp.json` is NOT expanded in v1 — values pass through literally.

## Slash Commands

Four homes, checked in this order. Add a command to the _first_ one that fits:

| Kind            | Lives in                                              | Use when                                                           | Reaches ezcoder-app?                      |
| --------------- | ----------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------ |
| UI-handled      | `handleSubmit` in `ui/App.tsx`                        | needs React state (overlays, live items, token counters)           | no — app uses buttons                |
| Registry        | `createBuiltinCommands()` in `core/slash-commands.ts` | needs session (messages, auth, settings) via `SlashCommandContext` | yes, via `AgentSession.prompt()`     |
| Prompt-template | `core/prompt-commands.ts`                             | injects a prompt for the agent to execute                          | yes — listed in the app's slash menu |
| Custom          | `.ezcoder/commands/*.md`                                   | project-local prompt templates                                     | yes                                  |

Gotchas:

- `/model`, `/compact`, `/quit` exist in **both** App.tsx and the registry — the TUI
  handlers win (checked first); the registry copies are what ezcoder-app actually runs.
- `/rewind` and `/clear` are TUI-only. A registry entry that has no app equivalent must
  say so (see `/rewind`'s `isGgApp()` branch) rather than echo a dead pointer.
- Registry commands needing new capabilities: add the method to `SlashCommandContext`
  and wire it in `AgentSession.createSlashCommandContext()`.

## Multi-root workspaces (`/add-dir`)

`/add-dir <path>` (alias `/adddir`; no args lists current roots) adds a second
workspace root for cross-repo work. Tools already resolve absolute paths and LSP
does per-file root detection, so only three things change: `resolveWriteGuard`
(`core/workspace-guard.ts`) allows writes under `additionalRoots`, `AgentSession`
holds the resolved list (`addDirectory` / `getAdditionalRoots`), and the system
prompt's Environment section gains `- Additional roots: …`. That section sits in
the **cached prefix**, so each `/add-dir` costs exactly one cache-miss turn —
accepted deliberately, since a root advertised only in the uncached suffix would
drift from the tool behaviour it describes. The sidecar exposes the roots in
`/state` + the `extras` SSE frame; ezcoder-app's header shows a `+N roots` badge.
Project-context (`CLAUDE.md`) collection from extra roots is _not_ implemented.

## Network egress allowlist

Off by default. `~/.ezcoder/settings.json`: `"networkMode": "off" | "allowlist"` and
`"networkAllow": ["github.com", "*.githubusercontent.com"]` (leading `*.` matches
subdomains only). Two layers, with honestly different strength — see
`core/network-guard.ts`:

- **Real enforcement**: `web-fetch` and `web-search` check every request URL _and
  every redirect hop_. These are our own egress paths, so nothing escapes them.
- **Defence in depth, bypassable by design**: `extractCommandHosts` recognises
  `curl`/`wget`, `git clone|fetch|pull|push|ls-remote`, `ssh`/`scp`/`rsync`, and
  package-manager installs, and `bash` refuses a disallowed host. A command with
  no recognised host is never blocked. `python -c`, a shell variable, or a
  base64'd URL walks straight past it — this is not an OS sandbox.

When allowlist mode is on, the Environment section lists the allowed hosts so the
model plans around the policy instead of discovering it through failures.

## Reasoning-field detection (gg-ai)

OpenAI-compatible endpoints disagree on the thinking field name.
`providers/reasoning-field.ts` reads the first of `reasoning_content`,
`reasoning`, `reasoning_text` present (that order — `reasoning_content` stays
authoritative, so every endpoint we ship today is byte-identical on the wire),
remembers which one an endpoint used in a bounded 64-entry cache keyed by
`provider|baseUrl|model`, and `toOpenAIMessages` echoes history back using that
same name. Before this, endpoints naming it `reasoning` (newer vLLM, some
gateways) lost 100% of their thinking content silently.

There is also support for **prompt-template commands** (built-in from `core/prompt-commands.ts` and custom from `.ezcoder/commands/` directory).

## Local models (Ollama / LM Studio / llama.cpp / vLLM)

A `local` provider (gg-ai) plus runtime discovery (gg-core) puts every model the
user already runs into the same picker as the hosted ones. No config file, no CLI
flag — the four well-known servers are probed on their documented ports, and
extra endpoints are added from the UI.

- **Discovery** — `packages/core/src/local-models.ts`. `probeEndpoint()` calls
  `GET {baseUrl}/models`, then enriches per server kind because `/v1/models`
  reports no capabilities: Ollama `POST /api/show` (`capabilities[]` +
  `model_info["<arch>.context_length"]`), LM Studio `GET /api/v0/models`
  (`type`/`state`/`max_context_length`), llama.cpp `GET /props`
  (`default_generation_settings.n_ctx`), vLLM/generic nothing (`max_model_len`
  sometimes rides the model object). Probing **never throws** — an unreachable
  server is a normal state with a `reason`, not an error toast. 30s cache;
  `force` bypasses it (the Scan button, after an `ollama pull`).
- **Capability rules that matter.** `supportsTools` comes from Ollama's
  capabilities but defaults to **true** for servers that report nothing (they
  gate per-model server-side; assuming false would make them all unusable).
  Unknown context window ⇒ conservative **8192** with a "?" chip, because an
  over-guess is a mid-run provider 400 that auto-compaction already sailed past.
  Embedding/rerank models are dropped (LM Studio `type`, or an `embed|rerank` id).
- **Id scheme** — `local/<endpointId>/<rawModelId>`
  (`formatLocalModelId`/`parseLocalModelId`). The prefix is routing only:
  gg-ai's `localWireModelId()` strips it in the `local` provider so the server
  sees its own id. A local stream with no `baseUrl` throws a clear `EZCoderAIError`
  instead of guessing someone else's port.
- **Auth** — one `local:<endpointId>` entry per endpoint in `~/.ezcoder/auth.json`
  carrying that endpoint's `baseUrl` (+ optional key), written by
  `AuthStorage.setLocalEndpoint()`. Each local `ModelInfo` sets
  `authStorageKeys: ["local:<id>"]`, so the existing ordered-storage-key override
  resolves it and `effectiveBaseUrl` picks the endpoint up with **zero new code
  paths**. Only endpoints that answered a probe get a credential.
- **Registry** — `MODELS` stays static; discovered models live in a runtime map
  (`registerRuntimeModels` / `clearRuntimeModels` / `getAllModels`), which
  `getModel`/`getModelsForProvider` consult. `getDefaultModel("local")` never
  throws (placeholder before the first scan).
- **Thinking (verified against real Ollama 0.32).** `getSupportedThinkingLevels("local", id)`
  returns `[]` unless the probe said the model reasons — not defensive padding:
  Ollama **hard-400s** (`"llama3.2" does not support thinking`) if
  `reasoning_effort` reaches a non-thinking model, and the footer toggle hides
  itself on an empty level list. A thinking-capable local model **cycles**
  through its ladder then off (`provider === "local"` is in `shouldCycleLevels`),
  and the ceiling is the **endpoint's**, set at discovery by
  `maxThinkingLevelFor`: Ollama accepts `low|medium|high|max`, every other server
  stops at `high` (only Ollama documents `max`). **No local server accepts
  `xhigh`** — Ollama answers `invalid reasoning value: 'xhigh' (must be "high",
"medium", "low", "max", or "none")` — so local uses its own wire vocabulary via
  `toLocalReasoningEffort` (`max`/`ultra`/`xhigh` → `"max"`), assigned through the
  same out-of-SDK-union escape hatch as Kimi's `max`. Ollama names the streamed
  field `reasoning`, which `reasoning-field.ts` already handles.
- **Selection gating.** `POST /model` **rejects** a tool-less local model
  (409 + reason) and re-probes the endpoint first, so a stopped server gives
  "Ollama isn't running at …" instead of a mid-run failure. A connection error
  while a local model is active gets endpoint-specific guidance
  (`localNetworkGuidance`) — never "disable your VPN".
- **Surface** — sidecar `GET /local`, `POST /local/scan`, `POST /local/endpoints`,
  `DELETE /local/endpoints/:id` (+ the four `agent_local*` Rust proxies);
  custom endpoints persist in `~/.ezcoder/ezcoder-app.json` under `localEndpoints`
  (`packages/cli/src/core/local-endpoint-store.ts`).
  `ezcoder-app/src/LocalModelsModal.tsx` (from the login hub) is **read-only status**:
  which servers are up, each model's context + capabilities in a row tooltip.
  **Selection happens only in the footer `ModelSelect`** — one selection surface
  in the app. That picker groups **every** provider under its own heading
  (`provider-labels.ts`, labels matching the login hub's tiles), Local pinned
  last, and renders tool-less local models disabled with the reason.
- **Not built** (deliberately): native Ollama/LM Studio transports, model
  download/load/unload, embeddings, per-model context override, and a CLI screen
  for local endpoints (the CLI still inherits the models via the shared registry).

## Local-backend stream watchdog (gg-agent)

`isLocalBackendUrl` (`gg-agent/src/local-backend.ts`) is true for `localhost`,
`127.0.0.0/8`, `::1`, `0.0.0.0`, and `*.local`. For those backends the agent loop
disables the 45 s **first-event** timeout entirely (a llama.cpp/vLLM prefill of a
large prompt takes minutes; aborting guarantees a cold-prefill retry loop that
never converges) and raises the initial hard cap to 10 min. The 90 s inter-event
idle timer still arms as soon as the first event lands, and ESC/Ctrl+C abort is
untouched.
