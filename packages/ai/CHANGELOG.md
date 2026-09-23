# @prestyj/ai

## 5.27.0

## 5.26.0

## 5.25.1

## 5.25.0

### Minor Changes

- fa24660: Add Claude Opus 5.5 (`claude-opus-5-5`, released 2026-09-22) and make it the default Anthropic model. 1M context, 128k output, image input, always-on adaptive thinking with the full effort ladder (low→max, xhigh included), at $4/$20 MTok — cheaper than the Opus 5 it leads.

  - Fresh sessions start at `medium` effort, matching Anthropic's declared server-side default for this model (Opus 5 ran `high`, and 5.5 thinks more per turn at a given level). The `max` ceiling is unchanged, so `/thinking` still cycles all the way up.
  - Forced tool use (`tool_choice` `any`/`tool`) returns a 400 on Opus 5.5 and the Fable/Mythos line, so `@prestyj/ai` now downgrades it to `auto` instead of failing the request.
  - Thinking can't be disabled on this model; `@prestyj/ai` already omits the `thinking` field when thinking is off, so that path is unaffected.
  - Footers short-name it "Opus" (Opus 5 becomes "Opus 5"), login/provider descriptions list it, and ezboss's default boss model moves from `claude-opus-5` to `claude-opus-5-5`. Opus 5 stays registered as a legacy option — it's the last Opus that accepts disabled thinking and forced tool use.

- becf968: Add UI library tooling, cut slow agent turns, and refresh the model lineup.

  - New `ui_registry` and `ui_adopt` tools, plus bundled UI-library guidance in the `evidence-led-ui` skill, so UI work starts from a real component library instead of hand-rolled markup. Adoption writes stay on the local filesystem and go through the same write guard (including goal mode) as every other mutation.
  - Slow-turn fixes: compaction triggers are latency-capped, and the stream's first-event watchdog now scales with prompt size (45s base, 180s ceiling) instead of a fixed budget. A large uncached prompt can legitimately take 44-68s to prefill, and the old fixed 45s timeout turned those turns into false stalls plus a full cold re-prefill. Per-turn prompt-cache health is now observable from normalized provider usage.
  - Model lineup: adds Grok 4.7 and the full-modal MiMo-V2.6 series (image and video input across Pro, Flash, and Pro-UltraSpeed), and retires the superseded Grok 4.6/4.5 and MiMo-V2.5 ids. Saved sessions on a retired id fall back to the provider default on next start.
  - Temporary-file access now resolves correctly across macOS, Linux, and Windows, and ACP forwards tool images in both live updates and replayed history.

## 5.24.0

## 5.23.0

### Minor Changes

- eb88fc6: Upgrade Xiaomi to the MiMo-V2.6 series, replacing the V2.5 entries one-for-one:
  `mimo-v2.6-pro` (the new Xiaomi default), `mimo-v2.6-flash`, and the
  API-Credits-only `mimo-v2.6-pro-ultraspeed`. The whole series is full-modality,
  so image and video attachments now work on the flagship itself — V2.5 needed the
  separate omni model for that. Pro and Flash are verified against the live Token
  Plan host: both return `image_tokens`/`video_tokens` in usage, cap completions at
  131,072 tokens, and clamp prompts at a binary 1M (1,048,576) context window.
  Flash is registered as the provider's `low` cost tier, so scout sub-agents and
  compaction summaries route to it instead of paying Pro rates. UltraSpeed host
  routing is now matched by the `-ultraspeed` suffix rather than a hard-coded
  model id, so future generations route to the platform host without a code change.

## 5.22.2

## 5.22.1

## 5.22.0

## 5.21.0

## 5.20.0

## 5.19.0

## 5.18.0

## 5.17.0

## 5.16.2

## 5.16.1

## 5.16.0

## 5.15.0

## 5.14.1

### Patch Changes

- Import upstream improvements for verification, autopilot review, reply limits, model downloads, GLM vision, cross-platform attachments, transcript stability, and sandbox controls.

  Exclude tests from the published CLI and refresh vulnerable transitive dependencies.

## 5.14.0

## 5.13.0

### Minor Changes

- Add GLM-5.3 support, bundled Bulletproof/Lean/Durable skills, project MCP trust controls, authenticated desktop sidecar access, verification gates, background wake rules, review coverage events, and safer editing and empty-response handling.

## 5.12.0

### Minor Changes

- Bring the latest upstream capabilities into EZ Coder while preserving the fork's Goal orchestration, desktop sessions, provider limits, and Nolan persona.

  Add LSP-backed code navigation, broader code search, schema-saving tool tiers, bundled child agents, Grok subscription OAuth with API-key fallback, resilient provider retries and streamed gateway errors, MCP image forwarding, themed terminal output, and the bundled compliance-guard skill.

## 5.11.0

## 5.10.0

## 5.9.0

## 5.8.0

## 5.7.0

## 5.40.1

## 5.40.0

## 5.39.4

## 5.39.3

## 5.39.2

## 5.39.1

## 5.39.0

## 5.38.0

## 5.37.0

## 5.36.0

## 5.35.1

### Patch Changes

- 8e124fd: Fix "no low surrogate in string" / Bad Request errors from Anthropic and OpenAI.

  An unpaired UTF-16 surrogate anywhere in the conversation (a model streaming a
  split emoji inside tool-call arguments, or a character-indexed truncation that
  cut an astral character in half) made the JSON request body unparseable for
  every provider — and it persisted in history, so retries and model switches
  failed identically.

  `stream()` now scrubs lone surrogates from all messages at the single provider
  boundary, and the tool-result/shell/web-fetch/grep truncation paths cut on
  character boundaries instead of splitting surrogate pairs.

## 5.35.0

## 5.34.3

## 5.34.2

## 5.34.1

## 5.34.0

## 5.33.0

## 5.32.0

## 5.31.0

## 5.30.3

## 5.30.2

## 5.30.1

## 5.30.0

## 5.29.1

## 5.29.0

## 5.28.0

## 5.27.0

## 5.26.3

## 5.26.2

## 5.26.1

## 5.26.0

## 5.25.0

## 5.24.0

## 5.23.3

## 5.23.2

## 5.23.1

## 5.23.0

### Minor Changes

- a6a78c2: Add Claude Opus 5 (`claude-opus-5`, released 2026-07-24) to the model registry — 1M context, 128k output, image input, adaptive thinking with the full effort ladder (low→max, xhigh included), $5/$25 MTok (same price as Opus 4.8). gg-ai treats it as an adaptive-thinking model (no interleaved-thinking beta, xhigh passes through), footers short-name it "Opus" (Opus 4.8 becomes "Opus 4.8"), login/provider descriptions mention it, and gg-boss's default boss model moves from `claude-opus-4-8` to `claude-opus-5`. Opus 4.8 stays registered as a legacy option.

## 5.22.6

## 5.22.5

## 5.22.4

## 5.22.3

## 5.22.2

## 5.22.1

### Patch Changes

- Reliability fixes from the baseline harness (bench/baseline):
  - **Truncated-stream guard (gg-ai):** a clean stream close with no terminal event (no `message_stop` / `finish_reason`) now throws a retryable `ProviderError(504)` instead of silently returning partial text as a phantom-complete `end_turn`. Applies to both the Anthropic and OpenAI-compatible providers.
  - **Sidecar bounds (ezcoder):** inbound HTTP bodies capped at 10 MB (413) via `readCappedBody`; the `~/.ezcoder` progress `fs.watch` handle is now closed on shutdown; the project-file glob search streams and bails after 50k entries. Closes three unbounded-memory/leak paths.
  - **Cap-divergence marker (gg-agent):** `capToolResults`/`capTurnToolResults` now stamp `ToolResult.capped = { originalChars, keptChars, scope }` when they trim, so the event-transcript vs model-input divergence is programmatically visible. Internal metadata only — never serialized to the provider.
  - **Empty-part serializer fix (gg-ai):** `toAnthropicMessages` no longer emits empty text parts (user `""`, user `{text:""}`, settled assistant `""`), eliminating live Anthropic 400 "text content blocks must be non-empty" failures.
  - **Tool-id remap fix (gg-ai):** `remapToolCallId` now strips the full `toolu_` prefix (`slice(6)`), mapping `toolu_01ABC` → clean `call_01ABC` instead of the lossy double-underscore `call__01ABC`.

## 5.22.0

## 5.21.0

## 5.20.5

## 5.20.4

## 5.20.3

## 5.20.2

## 5.20.1

## 5.20.0

## 5.19.6

## 5.19.5

## 5.19.4

## 5.19.3

### Patch Changes

- b6e7562: Compress large OpenAI Codex request bodies with zstd and automatically retry HTTP 507 upstream retry-buffer failures.

## 5.19.2

## 5.19.1

## 5.19.0

## 5.18.0

### Minor Changes

- e00de5b: Add Kimi K3 as Moonshot's default model with its 1M-token multimodal registry metadata and endpoint-specific max-effort request handling for both the public API and Kimi Code OAuth. Keep Kimi K2.7 Code available as the dedicated coding alternative.

## 5.17.0

### Minor Changes

- a3916ff: Harden provider error handling, cancellation settlement, review evidence, LSP confidence, route-aware context limits, turn metrics, and durable child-agent recovery.

## 5.16.0

## 5.6.0

## 5.5.0

## 5.4.1

### Patch Changes

- Fix OpenAI Codex GPT-5.6 Responses-Lite request handling for Sol, Terra, and Luna.

## 5.4.0

### Minor Changes

- Sync upstream ezcoder (27 commits): add GPT-5.6 Sol/Terra/Luna models with the `max` reasoning ladder, fix Gemini GA model IDs (`gemini-3-flash`, `gemini-3.1-pro-preview`), add the subscription usage meter, make error hints UI-agnostic, and fix the sidecar bundler dropping transitive MCP deps.

## 5.3.1

### Patch Changes

- Fix app task runs hanging when models enter plan mode; sync upstream framework changes.

## 5.3.0

## 5.2.0

## 5.1.1

## 5.1.0

## 5.0.1

### Patch Changes

- a013269: Add Xiaomi MiMo-V2.5-Pro UltraSpeed (`mimo-v2.5-pro-ultraspeed`). The model is
  served only from the standard MiMo platform host (`api.xiaomimimo.com/v1`), not
  the Token Plan subscription host, so the Xiaomi provider now routes that model
  id to the platform endpoint (a stored Token-Plan baseUrl is overridden, while an
  explicit custom baseUrl still wins). Fixes the "Not supported model" error when
  selecting UltraSpeed.

## 5.10.0

## 5.9.7

## 5.9.6

## 5.9.5

## 5.9.4

## 5.9.3

## 5.9.2

## 5.9.1

### Patch Changes

- Fix error guidance to use desktop-app UI actions instead of CLI commands in the ezcoder-app

## 5.9.0

## 5.8.8

## 5.8.7

## 5.8.6

## 5.8.5

## 5.8.4

## 5.8.3

## 5.8.2

## 5.8.1

## 5.8.0

## 5.7.0

## 5.6.3

## 5.6.2

## 5.6.1

## 5.6.0

## 5.5.1

## 5.5.0

## 5.4.3

## 5.4.2

## 5.4.1

## 5.4.0

## 5.3.0

## 5.2.0

## 5.1.2

## 5.1.1

## 5.1.0

## 5.0.0

## 4.15.0

## 4.14.3

## 4.14.2

## 4.14.1

## 4.14.0

## 4.13.3

## 4.13.2

## 4.13.1

## 4.13.0

### Minor Changes

- Update system prompt talk section for ADHD-readable responses

  Rewrite `renderTalkSection()` so every reply leads with the outcome word
  (Fixed/Done/Broken/Failed), enforces bottom-line-first scanning, one idea
  per line, pick-don't-menu, concrete metrics, no unresolved it-depends, and
  affirmative phrasing. Designed for fast scanning and low working memory.

## 4.12.2

### Patch Changes

- Fix Windows sidecar crash: the session-folder name encoder (`encodeCwd`) now strips Windows extended-length path prefixes (`\\?\` and `\\?\UNC\`) and all reserved filename characters (`<>:"|?*`). Previously, Windows canonicalized cwds (`\\?\C:\Users\brams`) produced illegal folder names containing `?`, causing `mkdir` ENOENT and a fatal sidecar crash on startup — blocking OAuth/login for all Windows users.

## 4.12.1

### Patch Changes

- Add performance benchmarks and optimize streaming, tool execution, and rendering pipeline
  - edit-diff: lazy normalization cache for fuzzy matching (5-7× faster on large files)
  - ls: parallel stat() via Promise.all (3.7-5.5× faster on large dirs)
  - StreamResult: backpressure with high/low-water marks to bound memory (10× reduction)
  - agent-loop: mixed-mode tool execution batches consecutive parallel-safe tools (2-10× faster)
  - agent-loop: per-tool timeout isolation via AbortSignal.any (prevents indefinite hangs)
  - agent-loop: gate diagnostic char-counting behind \_diagFn (eliminates per-turn overhead)
  - Markdown.tsx: block-level memoization via marked.lexer (only active block re-parses)
  - App.tsx: requestAnimationFrame-throttled appendAssistant (5-10× fewer re-renders)
  - benchmarks: full harness with before/after comparison tables (pnpm bench)

## 4.12.0

### Minor Changes

- Add generate_image tool: generate and edit images via OpenAI gpt-image-2 through the Codex backend. Conditionally registered when OpenAI is connected. Includes inline image preview in transcript, shimmering skeleton placeholder during generation, 1:1 history reconstruction for tool-produced images and sub-agent groups on session resume, and image path exposure for multi-turn editing.

## 4.11.3

## 4.11.2

## 4.11.1

## 4.11.0

## 4.10.2

## 4.10.1

## 4.10.0

### Minor Changes

- Update Kimi to K2.7 (`kimi-k2.7-code`) as the Moonshot default model, replacing Kimi K2.6 across the registry, CLI, login UI, and docs.

  Harden Kimi OAuth token refresh so it no longer silently falls back to a paid Moonshot API key: refresh reuses the existing refresh token when the server doesn't rotate it, tokens are renewed proactively before expiry (60s skew), `baseUrl` is preserved across refreshes, and a genuinely-dead OAuth credential now logs a warning instead of switching billing silently.

## 4.9.1

## 4.9.0

## 4.8.7

## 4.8.6

## 4.8.5

## 4.8.4

## 4.8.3

## 4.8.2

## 4.8.1

## 4.8.0

### Minor Changes

- Add Claude Fable 5 (`claude-fable-5`) and Claude Mythos 5 (`claude-mythos-5`) to the model registry with adaptive thinking (low→max), correct beta-header handling in the Anthropic provider, footer short names, and a clear invite-only (Project Glasswing) error for Mythos instead of the raw `not_found_error`.

## 4.7.0

## 4.6.3

### Patch Changes

- Fix Anthropic rejecting foreign `raw` content blocks (e.g. OpenAI Codex encrypted reasoning items) when switching a session to an Anthropic model. Raw blocks whose wire type isn't a valid Anthropic input content block are now dropped on the way out.

## 4.6.2

### Patch Changes

- Fix OpenAI OAuth account switching by adding prompt=login to authorize URL. Previously, re-running `ezcoder login` with OpenAI would silently re-approve the cached browser session, preventing users from switching accounts.

## 4.6.1

### Patch Changes

- Fix provider stream cancellation and usage-limit handling, and sanitize Codex tool-call IDs when continuing sessions across model transports.

## 4.6.0

### Minor Changes

- Add Xiaomi MiMo-V2.5 models with native video analysis. The text-only
  `mimo-v2.5-pro` is now the Xiaomi default, and the omnimodal `mimo-v2.5`
  supports native image and video understanding. Video read through the read
  tool is now delivered to MiMo (and other non-Moonshot OpenAI-compatible video
  models) in a follow-up user message as inline base64 `video_url`, the shape
  the API accepts — fixing the fallback where the model resorted to ffmpeg frame
  extraction. The read tool is also rebuilt on model switch so its video
  capability tracks the active model.

## 4.5.0

## 4.4.0

### Minor Changes

- 9e381ad: Extract `@prestyj/core` — a provider-agnostic, UI-free shared foundation
  that owns the model registry, thinking levels, app paths, OAuth + auth storage,
  the file-writer logger core, telegram + voice transcription, and the
  self-updater. ezcoder, gg-boss, and ez-editor now inherit a single source of
  truth for provider-coupled code instead of maintaining duplicates.

  Move provider-error classification into `@prestyj/ai` as
  `classifyProviderError`, reconciled with `isHardBillingMessage` so billing
  wording lives in one place.
