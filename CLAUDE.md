# ezcoder

A modular TypeScript framework for building LLM-powered apps — from raw streaming to full coding agent.

## npm Packages

| Package | npm Name | Description |
|---|---|---|
| `packages/ai` | `@prestyj/ai` | Unified LLM streaming API |
| `packages/agent` | `@prestyj/agent` | Agent loop with tool execution |
| `packages/cli` | `@prestyj/cli` | CLI coding agent (`ezcoder`) |
| `packages/boss` | `@prestyj/boss` | Multi-agent orchestrator (`ezboss`) |
| `packages/editor` | `@prestyj/editor` | Skill / prompt editor TUI (`ezeditor`) |
| `packages/editor-premiere-panel` | `@prestyj/editor-premiere-panel` | Adobe Premiere extension panel |
| `packages/pixel` | `@prestyj/pixel` | Universal error tracking SDK (Node + Browser + Deno + Workers) |
| `packages/pixel-server` | (private — Cloudflare Worker) | Ingest backend (Workers + D1) |
| `packages/eyes` | `@prestyj/eyes` | Vision/OCR helper (`ezcoder-eyes`) |

**Install**: `npm i -g @prestyj/cli`

## Project Structure

```
packages/
  ├── ai/                 # @prestyj/ai — Unified LLM streaming API
  │   └── src/
  │       ├── types.ts       # Core types (StreamOptions, ContentBlock, events)
  │       ├── errors.ts      # EZCoderAIError, ProviderError
  │       ├── stream.ts      # Main stream() dispatch function
  │       ├── providers/     # Anthropic, OpenAI streaming implementations
  │       └── utils/         # EventStream, Zod-to-JSON-Schema
  │
  ├── agent/              # @prestyj/agent — Agent loop with tool execution
  │   └── src/
  │       ├── types.ts       # AgentTool, AgentEvent, AgentOptions
  │       ├── agent.ts       # Agent class + AgentStream
  │       └── agent-loop.ts  # Pure async generator loop
  │
  └── ezcoder/               # @prestyj/cli — CLI (ezcoder)
      └── src/
          ├── cli.ts         # CLI entry point
          ├── config.ts      # Configuration constants
          ├── session.ts     # Session management
          ├── system-prompt.ts # System prompt generation
          ├── core/          # Auth, OAuth, settings, sessions, extensions
          │   ├── oauth/     # PKCE OAuth flows (anthropic, openai)
          │   ├── compaction/ # Context compaction & token estimation
          │   ├── mcp/       # Model Context Protocol client
          │   └── extensions/ # Extension system
          ├── tools/         # Agentic tools (bash, read, write, edit, grep, find, ls, web-fetch, subagent)
          ├── ui/            # Ink/React terminal UI components & hooks
          │   ├── components/ # 25+ UI components (one per file)
          │   ├── hooks/     # useAgentLoop, useSessionManager, useSlashCommands, etc.
          │   └── theme/     # dark.json, light.json
          ├── modes/         # Execution modes (interactive, print, json)
          └── utils/         # Error handling, git, shell, formatting, image
```

## Package Dependencies

`@prestyj/ai` (standalone) → `@prestyj/agent` (depends on ai) → `@prestyj/cli` (depends on both)

## Tech Stack

- **Language**: TypeScript 5.9 (strict, ES2022, ESM)
- **Package Manager**: pnpm workspaces
- **Build**: tsc
- **Test**: Vitest 4.0
- **Lint**: ESLint 10 + typescript-eslint (flat config)
- **Format**: Prettier 3.8
- **CLI UI**: Ink 6 + React 19
- **Key deps**: `@anthropic-ai/sdk`, `openai`, `zod` (v4)

## Commands

```bash
# Build & typecheck all packages
pnpm build                          # tsc across all packages
pnpm check                          # tsc --noEmit across all packages

# Per-package
pnpm --filter @prestyj/ai build
pnpm --filter @prestyj/agent build
pnpm --filter @prestyj/cli build
```

## Publishing to npm

Must use `pnpm publish` (not `npm publish`) so `workspace:*` references resolve to real versions.

### Steps

1. Bump version in all 3 `package.json` files (keep them in sync)
2. Build all packages: `pnpm build`
3. Publish in dependency order:

```bash
pnpm --filter @prestyj/ai publish --no-git-checks
pnpm --filter @prestyj/agent publish --no-git-checks
pnpm --filter @prestyj/cli publish --no-git-checks
```

### Auth

- npm granular access token must be set: `npm set //registry.npmjs.org/:_authToken=<token>`
- All packages use `"publishConfig": { "access": "public" }` (required for scoped packages)
- `--no-git-checks` skips git dirty/tag checks (needed since we don't tag releases)

### Verify

```bash
npm view @prestyj/cli versions --json   # check published versions
npm i -g @prestyj/cli@<version>         # test install
ezcoder --help                                # verify CLI works
```

If `npm i` gets ETARGET after publishing, clear cache: `npm cache clean --force`

## Organization Rules

- Types → `types.ts` in each package
- Providers → `providers/` directory in @prestyj/ai
- Tools → `tools/` directory in @prestyj/cli, one file per tool
- UI components → `ui/components/`, one component per file
- OAuth flows → `core/oauth/`, one file per provider
- Tests → co-located with source files

## Code Quality — Zero Tolerance

After editing ANY file, run:

```bash
pnpm check && pnpm lint && pnpm format:check
```

Fix ALL errors before continuing. Quick fixes:
- `pnpm lint:fix` — auto-fix ESLint issues
- `pnpm format` — auto-fix Prettier formatting
- Use `/fix` to run all checks and spawn parallel agents to fix issues

## Key Patterns

- **StreamResult/AgentStream**: dual-nature objects — async iterable (`for await`) + thenable (`await`)
- **EventStream**: push-based async iterable in `@prestyj/ai/utils/event-stream.ts`
- **agentLoop**: pure async generator — call LLM, yield deltas, execute tools, loop on tool_use
- **OAuth-only auth**: no API keys, PKCE OAuth flows, tokens in `~/.ezcoder/auth.json`
- **Zod schemas**: tool parameters defined with Zod, converted to JSON Schema at provider boundary
- **Debug logging**: `~/.ezcoder/debug.log` — timestamped log of startup, auth, tool calls, turn completions, errors. Truncated on each CLI restart. Singleton logger in `src/core/logger.ts`

## Pixel — error tracking + auto-fix queue

`@kenkaiiii/gg-pixel` is a drop-in error tracking SDK. Errors flow to a Cloudflare Worker (`gg-pixel-server`) backed by D1. `ggcoder pixel` opens an in-Ink overlay that lists open errors per project and hands each one off to the existing agent loop — same UX as the Task pane.

### CLI

```bash
ggcoder pixel install          # Detect framework, wire up SDK + .env, register project key
ggcoder pixel                  # Open the in-Ink overlay (also: Ctrl+E inside running ggcoder)
ggcoder pixel fix <error_id>   # Fix one error end-to-end (subprocess flow, for non-TTY use)
ggcoder pixel run              # Auto-fix every open error (non-interactive)
```

### In-Ink fix flow (the main path)

`Ctrl+E` from inside ggcoder, or `ggcoder pixel`, opens `PixelOverlay`. Keys: `↑↓ navigate · Enter fix one · f fix all · d delete · Esc close`.

When a fix starts, `startPixelFix(errorId)` in `App.tsx` swaps **four** things in lockstep before calling `agentLoop.run(prep.prompt)`:

1. `process.chdir(prep.projectPath)` — for code reading `process.cwd()` directly.
2. `setCurrentTools(rebuildToolsForCwd(prep.projectPath))` — read/write/edit/bash/find/grep/ls/tasks/sub-agent are all baked with `cwd` at creation, so they MUST be rebuilt; chdir alone is not enough.
3. System prompt is rebuilt with the new project root (`buildSystemPrompt(prep.projectPath, …)`) and swapped into `messagesRef.current[0]` — this is the only place the model itself learns "where it is".
4. `setDisplayedCwd(prep.projectPath)` — Banner + Footer read this. Because Banner lives inside Ink's `<Static>`, also bump `staticKey` so Static remounts and re-renders the banner with the new path.

Reset chat state (`setHistory`, `setLiveItems`, `setStaticKey`, screen clear) **AFTER** the chdir is committed — otherwise the old-cwd banner gets written first and you see two banners stacked.

`onDone` in `useAgentLoop` finalizes the fix: `finalizePixelFix(prep)` observes the `fix/pixel-{id}` branch + commits and patches the D1 status to `awaiting_review` or `failed`. Run-all picks up the next open error via the same path.

### Backend

`packages/gg-pixel-server/` — Hono on Workers + D1. Routes:
- `POST /ingest` — SDK posts events; server dedupes by `(project_id, fingerprint)`. Validated + size-capped + per-project unique-fingerprint cap (10K). CORS-open since the publishable `project_key` is the auth boundary for ingest only.
- `POST /api/projects` — globally rate-limited (100/hr). Returns `{ id, key, secret }` once on creation; the `secret` is the bearer token for every other `/api/*` call from that project's owner.
- `GET /api/projects/:id/errors` — bearer-authed (`Authorization: Bearer sk_live_…`); 403 if the secret doesn't own the project.
- `GET /api/errors/:id` — bearer-authed + cross-project scoped (403 if the bearer's project doesn't own the row).
- `PATCH /api/errors/:id` — bearer-authed + scoped. Drives `open → in_progress → awaiting_review → merged` (or `failed`).
- `DELETE /api/errors/:id` — bearer-authed + scoped (used by `d` in the overlay).

`~/.gg/projects.json` stores `{ name, path, secret }` per project. The CLI reads the secret on every management call. Re-run `ggcoder pixel install` to refresh the secret if a mapping is legacy (no `secret` field).

## Slash Commands

There are two kinds of slash commands:

### 1. UI-handled commands (in `App.tsx`)

Commands that need direct access to React state (UI, overlays, token counters) are handled inline in `handleSubmit` in `src/ui/App.tsx`. These short-circuit before the slash command registry.

**Current UI commands:** `/model` (`/m`), `/compact` (`/c`), `/quit` (`/q`, `/exit`), `/clear`

To add a new UI command:
1. Add a condition in `handleSubmit` after the existing checks:
   ```tsx
   if (trimmed === "/mycommand") {
     // manipulate React state directly
     setLiveItems([{ kind: "info", text: "Done.", id: getId() }]);
     return;
   }
   ```
2. If the command needs to reset agent state, call `agentLoop.reset()`.

### 2. Registry commands (in `core/slash-commands.ts`)

Commands that don't need React state live in `createBuiltinCommands()` in `src/core/slash-commands.ts`. They receive a `SlashCommandContext` with methods like `switchModel`, `compact`, `newSession`, `quit`, etc.

**Current registry commands:** `/model` (`/m`), `/compact` (`/c`), `/help` (`/h`, `/?`), `/settings` (`/config`), `/session` (`/s`), `/new` (`/n`), `/quit` (`/q`, `/exit`)

Note: `/model`, `/compact`, and `/quit` exist in both — the UI handlers in `App.tsx` take precedence since they're checked first.

To add a new registry command:
1. Add an entry to the array in `createBuiltinCommands()`:
   ```ts
   {
     name: "mycommand",
     aliases: ["mc"],
     description: "Does something useful",
     usage: "/mycommand [args]",
     execute(args, ctx) {
       // Use ctx methods or return a string to display
       return "Result text";
     },
   },
   ```
2. If the command needs new capabilities, add the method to `SlashCommandContext` interface and wire it up in `AgentSession.createSlashCommandContext()`.

### When to use which

| Need | Where |
|---|---|
| Modify UI state (history, overlays, live items) | `App.tsx` |
| Reset token counters | `App.tsx` (call `agentLoop.reset()`) |
| Access agent session (messages, auth, settings) | `slash-commands.ts` registry |
| Both UI + session access | `App.tsx` (can call session methods via props) |

There is also support for **prompt-template commands** (built-in from `core/prompt-commands.ts` and custom from `.ezcoder/commands/` directory).

## Upstream Sync (KenKaiii/gg-framework)

This repo is a fork of [KenKaiii/gg-framework](https://github.com/KenKaiii/gg-framework). The upstream uses different directory names and npm scope:

| Ours (ezcoder) | Upstream (gg-framework) |
|---|---|
| `packages/ai` | `packages/gg-ai` |
| `packages/agent` | `packages/gg-agent` |
| `packages/cli` | `packages/ggcoder` |
| `@prestyj/*` scope | `@kenkaiiii/*` scope |
| `~/.ezcoder/` config dir | `~/.gg/` config dir |
| `EZ Coder` branding | `GG Coder` branding |
| `EZCoderAIError` | `GGAIError` |
| `Gahroot/ezcoder` repo | `KenKaiii/gg-framework` repo |

### How to sync

**Option 1: Script** (from repo root):
```bash
./scripts/sync-upstream.sh           # merge + rename dirs + fix branding
./scripts/sync-upstream.sh --dry-run # preview changes without doing anything
```

Both do the same thing:
1. `git fetch upstream`
2. `git merge upstream/main`
3. Rename dirs: `gg-ai`→`ai`, `gg-agent`→`agent`, `ggcoder`→`cli`
4. Fix npm scope: `@kenkaiiii`→`@prestyj`
5. Fix branding: GG→EZ, `~/.gg/`→`~/.ezcoder/`, `GGAIError`→`EZCoderAIError`
6. Commit the fixup

### When merge conflicts happen

If `git merge upstream/main` hits conflicts:
1. Resolve them manually (`git diff --name-only --diff-filter=U` to see conflicted files)
2. Run `git merge --continue`
3. Re-run the script to apply directory renames + branding

### After syncing

```bash
pnpm install && pnpm build
# Verify no remaining upstream branding:
grep -rn 'kenkaiiii\|gg-ai\|gg-agent\|ggcoder\|GGAIError' packages/ --include='*.ts' --include='*.tsx' --include='*.json'
```

### Block art logos

The EZ block art logo (in `Banner.tsx` and `cli.ts`) uses different characters than upstream's GG logo. After syncing, verify the LOGO_LINES arrays still show EZ, not GG. The sync script handles text replacements but cannot detect block art changes — check visually with `ezcoder --help`.
