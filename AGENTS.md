# AGENTS.md

For Motion-mode work (videos, `ezcoder/src/motion-agent/`, `assets/motion/`),
read the Motion sections of `CLAUDE.md` first — that file is not auto-loaded.

## CI

CI lives in `.github/workflows/` and **must stay green**. `ci.yml` runs
build + typecheck + test + sidecar smoke on Linux/macOS/Windows — the Windows
leg is a blocking gate; never make it pass with `continue-on-error` or skipped
tests. Release automation (`release.yml`) triggers on `v*` tags; see
`.ezcoder/commands/release.md`.

Never commit with `--no-verify`.

<!-- gg:init:start -->
# EZ Coder

Desktop coding workspace (code / chat / motion modes): a React+Tauri app drives multi-provider agents running in a Node sidecar. The `ezcoder` CLI is an engine/distribution surface, not the primary UI. Read `CONTEXT.md` before naming anything.

## Ownership

- **`ezcoder-app`** — primary product: React UI + Rust proxy (`src-tauri/src/lib.rs`). User-facing work must work here; Ink/TUI-only is incomplete. Has no `@kenkaiiii/*` deps — reaches the engine only over HTTP.
- **`@prestyj/ai`** — LLM streaming, provider transports, content types, redaction, `formatError` wording.
- **`@prestyj/agent`** — agent loop, tool execution, retries, steering, aborts (depends on @prestyj/ai).
- **`@prestyj/core`** — UI-free models/thinking, local models, paths/logging, OAuth/auth storage, usage, Telegram, transcription, updates. Depends only on @prestyj/ai — never @prestyj/agent, React or Ink.
- **`ezcoder`** — `AgentSession`, tools, sessions/compaction, prompts/skills, MCP, chat/motion agents, CLI, and `app-sidecar.ts`. It also exports `./core/model-registry` and `./core/auth`; put model/auth logic in @prestyj/core, not a parallel copy.
- Retired: Realtime Voice, Boss, Editor, Premiere Panel, Eyes — never re-add to builds/releases.

## App architecture

- Flow: React → `ezcoder-app/src/agent.ts` → Tauri invoke → Rust proxy → HTTP → sidecar; SSE returns via Rust as window-targeted `agent-event`. Never fetch the HTTP daemon from the `tauri://` webview (mixed-content block).
- One shared Node daemon per app; each window maps to an in-process `AgentSession`, routed by `x-ez-session` header and `/events?session=`.
- A new sidecar feature needs three parts: sidecar handler, a Rust `#[tauri::command]` proxy that attaches the session, and a typed `agent.ts` wrapper. Session calls must `waitForReady()` — daemon port ready ≠ window session exists.
- Session creation is generation-guarded (`prepare_window_session`/`publish_window_session`): drop a late `POST /session` from an older project selection.
- `~/.ezcoder/ezcoder-app.json` is read by both Rust and the sidecar — change its schema on both sides. `~/.ezcoder/auth.json` is shared by app and CLI processes. App logs: `~/.ezcoder/ezcoder-app-sidecar.log` (not `debug.log`).
- Passing `skills` to `AgentSession` disables project/global skill discovery; Motion relies on this to isolate `assets/motion/skills` — never move them under `assets/skills`.
- App ASCII banners use FIGlet "Delta Corps Priest 1", lines padded to equal width, `line-height: 1`.

## Prompt-cache invariants

- Tool array is append-only: `tool_search` promotion must `push` onto `this.tools`; reordering invalidates the session's prefix cache (`system-prompt.tiering.test.ts`).
- Env changes mid-session go in as an appended "env delta" message (`core/env-delta.ts`); never re-render the cached system prompt (~10k–120k tokens lost to fix ~40).
- Core vs deferred tools: `tools/tool-tiers.ts`. A deferred tool needs a `TOOL_PROMPT_HINTS` entry (`tools/prompt-hints.ts`) — its only discoverability. A tool goes core only if used in >~1 in 5 sessions (measured with the private tool-tiering bench).

## Gotchas

- **Kill the daemon process tree**, not just Node: MCP/LSP children share its process group; Windows uses `taskkill /T /F`. `~/.ezcoder/ezcoder-app-sidecars` ledger cleans crash orphans.
- **`ExitRequested` must set `AppExiting` before `Destroyed` events**, or quit prunes every window from the restore snapshot.
- **App-visible agent errors go through `broadcastError`** in `app-sidecar.ts` (applies `formatError`, structured headline/guidance); raw provider strings regress the app.
- **Sidecar = bundle + real dependency trees.** `bundle-sidecar.mjs` externalizes native/lazy/WASM/LSP/MCP packages and copies them with pnpm symlinks dereferenced. Inlining them or dropping spawn/path-loaded packages breaks installed-only features.
- **Bundle on the target OS/arch.** `stage-node.mjs` stages official standalone Node as `eznode-<Rust triple>`; `process.execPath` may be dynamically linked.
- **Windows EBUSY/EPERM is the recurring CI failure:** files held by live children can't be removed. Wait for the process to exit before `rm` in tests; reuse `retryWindowsReplace` / `removeWhenReleased` patterns.
- **CI steps use `shell: bash`** — PowerShell only fails on the last line and once hid 72 failing tests.
- **pnpm settings live in `pnpm-workspace.yaml`**, not package.json `"pnpm"` (Dependabot's pnpm ignores it → frozen-lockfile breaks). A new native dep must be added to `onlyBuiltDependencies` or its install script silently doesn't run.
- `.github/ci/size-gate.mjs` ignores positional args — always pass `--only <artifact>`.
- `patches/ink@6.8.0.patch` is not applied; ezcoder uses the fork `@kenkaiiii/ink`.

## Workflows

- **Dev:** build the framework (@prestyj/ai → @prestyj/agent + @prestyj/core → ezcoder), then `pnpm --filter ezcoder-app tauri dev`. Debug Rust loads `packages/cli/dist/app-sidecar.js` — stale dist means stale app. Webview hot-reloads; Rust/sidecar changes need restart.
- **Distribution:** after framework build: `pnpm --filter ezcoder-app stage:node` → `bundle:sidecar` → `node ezcoder-app/scripts/smoke-sidecar.mjs` → Tauri packaging (which only packages the staged Node + `sidecar/`).
- **Release via `/release` (`.ezcoder/commands/release.md`).** Changesets fixed group (@prestyj/ai, @prestyj/agent, @prestyj/core, ezcoder): `changeset version` → build → commit → `changeset publish` (tags target HEAD) → push tags. Every npm release also needs a desktop release: `pnpm --filter ezcoder-app bump …` (package.json, tauri.conf.json, Cargo.toml, Cargo.lock), prepend `ezcoder-app/src/changelog.ts`, push `v<version>` last.
- A `v*` tag must be on `origin/main`; it publishes a non-draft release + updater `latest.json` for Apple-silicon macOS and Windows only (Linux AppImage hangs in CI). Preflight fails closed if any signing secret in the `desktop-production` environment is missing.
<!-- gg:init:end -->
