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
