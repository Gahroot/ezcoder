# @prestyj/cli

## 5.10.0

### Minor Changes

- Add local-model support, multi-directory workspace controls, and a more resilient agent runtime.

### Patch Changes

- @prestyj/ai@5.10.0
- @prestyj/agent@5.10.0
- @prestyj/core@5.10.0

## 5.9.0

### Minor Changes

- Add resilient agent recovery, richer sidecar tooling, stronger provider handling, and expanded UI guidance.

### Patch Changes

- @prestyj/ai@5.9.0
- @prestyj/agent@5.9.0
- @prestyj/core@5.9.0

## 5.8.0

### Minor Changes

- Add resilient Codex streaming, smarter context compaction, and expanded model support.

### Patch Changes

- @prestyj/ai@5.8.0
- @prestyj/agent@5.8.0
- @prestyj/core@5.8.0

## 5.7.0

### Minor Changes

- Make long-running agents safer and more resilient with durable child-agent recovery, stronger cancellation, clearer provider errors, and higher-confidence review and LSP evidence.

### Patch Changes

- @prestyj/ai@5.7.0
- @prestyj/agent@5.7.0
- @prestyj/core@5.7.0

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

- Updated dependencies [8e124fd]
  - @prestyj/ai@5.35.1
  - @prestyj/agent@5.35.1
  - @prestyj/core@5.35.1

## 5.35.0

### Minor Changes

- 3b9705d: Share MCP connections and language servers across sessions instead of spawning a set per session.

  A daemon runs many sessions at once — one per window, plus Nolan chat and Nolan autopilot within each — and each used to spawn its own child process for every MCP server and every language server. Measured on a four-window daemon: 34 processes and 3.3 GB, most of it identical work duplicated.
  - **MCP connections are now pooled per process** and reference counted, so one stdio child serves every session and exits when the last releases it. Sharing is the default for stdio servers; `shared: false` opts out a server that keeps per-caller state, and HTTP servers are never pooled because their auth and session id are per-connection. Elicitation is routed to the session whose tool call is in flight, and cancelled rather than guessed when that is ambiguous. A pooled server that exits on its own is retired from the pool, so the next session reconnects instead of inheriting a dead connection.
  - **Language servers are now pooled per (server, project root)**, so two windows open on one repo share a single tsserver stack instead of running two. Servers left unused for five minutes are reclaimed, which also releases roots that no window has open.
  - **tsserver runs two processes per root instead of four**, by disabling the syntax server and automatic typing acquisition — both exist for an interactive editor and are unused here — and caps its heap at the VS Code default.

### Patch Changes

- @prestyj/ai@5.35.0
- @prestyj/agent@5.35.0
- @prestyj/core@5.35.0

## 5.34.3

### Patch Changes

- Rework auto-compaction summaries: lead with the next step, cut redundant user-message transcripts and read-file lists, and supersede prior summaries instead of concatenating them
  - @prestyj/ai@5.34.3
  - @prestyj/agent@5.34.3
  - @prestyj/core@5.34.3

## 5.34.2

### Patch Changes

- Prevent macOS temp folders from flooding and blanking the desktop project picker.
  - @prestyj/ai@5.34.2
  - @prestyj/agent@5.34.2
  - @prestyj/core@5.34.2

## 5.34.1

### Patch Changes

- List project folders on disk in project discovery, add hidden-project support, and never prune skill output from context
  - @prestyj/ai@5.34.1
  - @prestyj/agent@5.34.1
  - @prestyj/core@5.34.1

## 5.34.0

### Minor Changes

- Add ACP file diffs and tool locations, publish plan progress as `plan` updates, and implement session/resume, session/close, session/delete, session_info_update, and message ids

### Patch Changes

- @prestyj/ai@5.34.0
- @prestyj/agent@5.34.0
- @prestyj/core@5.34.0

## 5.33.0

### Minor Changes

- Emit ACP `usage_update` session notifications so clients can show context-window usage, including the post-compaction drop and usage on session/new and session/load

### Patch Changes

- @prestyj/ai@5.33.0
- @prestyj/agent@5.33.0
- @prestyj/core@5.33.0

## 5.32.0

### Minor Changes

- Count Gemini reasoning tokens toward billed output usage, gate verification claims behind a fail-closed command classifier, select context by relevance when compacting, and add portable Agent Plugin bundles. Also ships an opt-in OS command sandbox.

### Patch Changes

- @prestyj/ai@5.32.0
- @prestyj/agent@5.32.0
- @prestyj/core@5.32.0

## 5.31.0

### Minor Changes

- Advertise built-in and project slash commands to ACP clients when sessions open or load.

### Patch Changes

- @prestyj/ai@5.31.0
- @prestyj/agent@5.31.0
- @prestyj/core@5.31.0

## 5.30.3

### Patch Changes

- Restore complete compacted-session history in ACP clients without duplicate retained messages or internal replay noise.
  - @prestyj/ai@5.30.3
  - @prestyj/agent@5.30.3
  - @prestyj/core@5.30.3

## 5.30.2

### Patch Changes

- Recover useful subagent findings after timeouts and prevent nested delegation from exhausting child turn budgets.
  - @prestyj/ai@5.30.2
  - @prestyj/agent@5.30.2
  - @prestyj/core@5.30.2

## 5.30.1

### Patch Changes

- Keep long autonomous tool runs lean by pruning stale outputs and oversized completed tool arguments.
  - @prestyj/ai@5.30.1
  - @prestyj/agent@5.30.1
  - @prestyj/core@5.30.1

## 5.30.0

### Minor Changes

- Add ACP session controls and make conversation compaction durable across resumes and concurrent processes.

### Patch Changes

- @prestyj/ai@5.30.0
- @prestyj/agent@5.30.0
- @prestyj/core@5.30.0

## 5.29.1

### Patch Changes

- Fix sub-agents hanging until their timeout instead of exiting when finished, and stop the Ideal review coverage gate from looping forever on deleted or unreadable files
  - @prestyj/ai@5.29.1
  - @prestyj/agent@5.29.1
  - @prestyj/core@5.29.1

## 5.29.0

### Minor Changes

- Add step-boundary transcript checkpoints and a run journal so crashes preserve completed work, MCP HTTP session recovery with single reconnect-and-replay, server-initiated elicitation support, a visual token budget for image downscaling, and capped backoff for background-process notifications.

### Patch Changes

- @prestyj/ai@5.29.0
- @prestyj/agent@5.29.0
- @prestyj/core@5.29.0

## 5.28.0

### Minor Changes

- List Claude Code and Codex sessions alongside EZ Coder's own for a project, tagged with their source and resumable on open, replacing the `/import` slash command

### Patch Changes

- @prestyj/ai@5.28.0
- @prestyj/agent@5.28.0
- @prestyj/core@5.28.0

## 5.27.0

### Minor Changes

- Add `/import` for resuming Claude Code, Codex and Cursor transcripts, gate turn completion on unread background processes, and migrate MCP to SDK v2 with an on-disk tool catalog cache

### Patch Changes

- @prestyj/ai@5.27.0
- @prestyj/agent@5.27.0
- @prestyj/core@5.27.0

## 5.26.3

### Patch Changes

- Fix session transcript restore: rebase marker anchors when compaction rewrites a session, heal stale anchors in existing session files, skip duplicate autopilot-injected user bubbles, and restore slash commands from the persisted invocation instead of matching drifted templates
  - @prestyj/ai@5.26.3
  - @prestyj/agent@5.26.3
  - @prestyj/core@5.26.3

## 5.26.2

### Patch Changes

- Fix concurrent prompts starting two runs on the same session, and announce queue depth the moment the agent consumes queued steering.
  - @prestyj/ai@5.26.2
  - @prestyj/agent@5.26.2
  - @prestyj/core@5.26.2

## 5.26.1

### Patch Changes

- Remove the project memory journal: it duplicated what the repo already tells the agent and suppressed real verification.
  - @prestyj/ai@5.26.1
  - @prestyj/agent@5.26.1
  - @prestyj/core@5.26.1

## 5.26.0

### Minor Changes

- Keep long tasks running and carry project history across sessions: the agent loop can now extend an exhausted turn budget when it is still making progress, finished sub-agents and background processes announce themselves instead of needing to be polled, mid-session model switches are recorded as durable replayable state, and compaction writes past-tense project history to `.ezcoder/memory.md` (on by default, `/memory-off` to disable).

### Patch Changes

- @prestyj/ai@5.26.0
- @prestyj/agent@5.26.0
- @prestyj/core@5.26.0

## 5.25.0

### Minor Changes

- Add local model support (Ollama, LM Studio, llama.cpp, vLLM) with runtime discovery, capability-gated tool/thinking support, and per-endpoint auth; add `/remove-dir` workspace command; keep the subscription usage meter from blanking on transient provider rate limits.

### Patch Changes

- @prestyj/ai@5.25.0
- @prestyj/agent@5.25.0
- @prestyj/core@5.25.0

## 5.24.0

### Minor Changes

- Add Markdown chat transcript export, network egress allowlist, multi-root `/add-dir`, and OpenAI-compatible reasoning-field detection

### Patch Changes

- @prestyj/ai@5.24.0
- @prestyj/agent@5.24.0
- @prestyj/core@5.24.0

## 5.23.3

### Patch Changes

- 1be7250: Fix Windows compatibility across project discovery, shell execution, MCP and LSP.
  - **Projects and sessions were invisible on Windows.** Every cwd extractor in
    project discovery gated on `cwd.startsWith("/")`, so a `C:\…` session header
    was rejected, discovery fell back to the lossy directory-name decode, and the
    project silently vanished from the picker. Absolute-path detection is now
    platform-agnostic (`C:\…`, `\\server\share\…`, `/…`), and both fallback
    decoders reconstruct real Windows paths.
  - **Extended-length paths no longer duplicate a project.** A cwd recorded as
    `\\?\C:\proj` (what Rust's `canonicalize()` produces) is normalized to its
    plain form on read, matching what `encodeCwd` already did on write.
  - **`persist` bash mode was completely broken on Windows.** It spawned a bare
    `bash`, but Git for Windows puts `cmd\` on PATH and `bash.exe` in `bin\`, so
    the spawn was always ENOENT. It now reuses the resolved shell, and no longer
    detaches on Windows (which only orphaned the shell past a crash).
  - **MCP stdio servers configured with `npx` never connected.** The MCP SDK
    spawns with `shell: false` and Windows' `CreateProcess` ignores `PATHEXT`, so
    the near-universal `{"command": "npx"}` config failed with an opaque
    "Connection closed". The command is now resolved across PATH × PATHEXT.
  - **LSP inline diagnostics never appeared on Windows.** Diagnostics are cached
    by `file://` URI; ours kept the drive letter's case while servers emit the
    lowercase form, so every lookup missed and LSP degraded silently.
  - **Background processes survived cancellation.** `killProcessTree` used a
    POSIX-only negative pid, leaving a timed-out command's whole descendant tree
    running. It now uses `taskkill /T /F`, resolved from `SystemRoot` rather than
    PATH.
  - `find`/`grep` glob patterns containing backslashes now match (backslash is
    picomatch's escape character, never a separator).
  - **Session persistence was broken on Windows.** `syncFile` opened the file
    read-only (`"r"`) and then called `fsync`, but Windows implements fsync as
    `FlushFileBuffers`, which requires a handle with WRITE access and fails with
    `EPERM` on a read-only one. Every durable session write funnels through that
    helper, so saving sessions, archiving cold sessions and writing redirects all
    threw. It now opens `"r+"`, and a failed flush is non-fatal (network shares
    and container overlays can reject fsync outright — losing durability there is
    acceptable, refusing to save the user's session is not).
  - @prestyj/ai@5.23.3
  - @prestyj/agent@5.23.3
  - @prestyj/core@5.23.3

## 5.23.2

### Patch Changes

- Fix named sub-agents receiving no MCP tools: a session with a `tools:` allow-list skipped MCP entirely unless an MCP whitelist was also set, so an agent listing `mcp__kencode-search__searchCode` silently fell back to training data. The whitelist is now derived from the agent definition and forwarded through every spawn path. Also removes the v5.22.6 seeded `auditor.md`/`skeptic.md` that shadowed the richer bundled agents, with hash-gated cleanup that leaves user-edited files untouched.
  - @prestyj/ai@5.23.2
  - @prestyj/agent@5.23.2
  - @prestyj/core@5.23.2

## 5.23.1

### Patch Changes

- fb85e4f: Fix Claude Opus 5's thinking-level cycle and retire Claude Opus 4.8. `thinking-level.ts` kept its own hardcoded Anthropic regexes, so Opus 5 was not recognised as adaptive and collapsed to a single non-cycling `max` level; it now exposes the full low → medium → high → xhigh → max ladder. Opus 4.8 is removed from the model registry, footers, provider descriptions, and the hardcoded JSON/RPC/sidecar/CLI defaults (all now `claude-opus-5`); gg-ai keeps wire-format support for the `claude-opus-4-8` ID since Anthropic still serves it. Also gave the Sol/Terra policy tests real timeouts so they stop flaking at vitest's 5s default.
  - @prestyj/ai@5.23.1
  - @prestyj/agent@5.23.1
  - @prestyj/core@5.23.1

## 5.23.0

### Minor Changes

- a6a78c2: Add Claude Opus 5 (`claude-opus-5`, released 2026-07-24) to the model registry — 1M context, 128k output, image input, adaptive thinking with the full effort ladder (low→max, xhigh included), $5/$25 MTok (same price as Opus 4.8). gg-ai treats it as an adaptive-thinking model (no interleaved-thinking beta, xhigh passes through), footers short-name it "Opus" (Opus 4.8 becomes "Opus 4.8"), login/provider descriptions mention it, and gg-boss's default boss model moves from `claude-opus-4-8` to `claude-opus-5`. Opus 4.8 stays registered as a legacy option.

### Patch Changes

- Updated dependencies [a6a78c2]
  - @prestyj/ai@5.23.0
  - @prestyj/core@5.23.0
  - @prestyj/agent@5.23.0

## 5.22.6

### Patch Changes

- Remove the retired /setup command and its auto-run/hint UI, fix /bullet-proof refusals with authorized-defensive-review framing plus seeded auditor/skeptic agents and batched skeptic verification, dedupe kencode/source_path guidance out of the Research section, gate the native-web-search claim to Anthropic, and slim the system prompt.
  - @prestyj/ai@5.22.6
  - @prestyj/agent@5.22.6
  - @prestyj/core@5.22.6

## 5.22.5

### Patch Changes

- Proactive OAuth token refresh at a lifetime-scaled threshold. Short-lived tokens (e.g. Kimi's 15-minute access token) now refresh at their halfway point instead of riding to the expiry cliff, eliminating the recurring 401s and the misleading "API Key appears invalid" run failures caused by concurrent-session refresh races. Ported from MoonshotAI/kimi-code's OAuthManager: refresh when within max(300s, lifetime × 0.5) of expiry.
  - @prestyj/ai@5.22.5
  - @prestyj/agent@5.22.5
  - @prestyj/core@5.22.5

## 5.22.4

### Patch Changes

- Fix memory tools killing the turn when the model sends content over the 600-character limit (over-limit input is now an ordinary, actionable tool error instead of a fatal "repeatedly issued invalid arguments" failure), make chat agents save durable memories proactively without being asked, fix false stream stalls for silent OpenAI reasoning, and anchor transcript error markers to persisted messages so resumed errors render at the bottom.
  - @prestyj/ai@5.22.4
  - @prestyj/agent@5.22.4
  - @prestyj/core@5.22.4

## 5.22.3

### Patch Changes

- Automatically recover from runaway tool-call streams and restore bundled TypeScript diagnostics and source inspection in the desktop sidecar.
  - @prestyj/ai@5.22.3
  - @prestyj/agent@5.22.3
  - @prestyj/core@5.22.3

## 5.22.2

### Patch Changes

- Keep live sessions responsive while multiple subagents stream in parallel.
  - @prestyj/ai@5.22.2
  - @prestyj/agent@5.22.2
  - @prestyj/core@5.22.2

## 5.22.1

### Patch Changes

- Reliability fixes from the baseline harness (bench/baseline):
  - **Truncated-stream guard (gg-ai):** a clean stream close with no terminal event (no `message_stop` / `finish_reason`) now throws a retryable `ProviderError(504)` instead of silently returning partial text as a phantom-complete `end_turn`. Applies to both the Anthropic and OpenAI-compatible providers.
  - **Sidecar bounds (ezcoder):** inbound HTTP bodies capped at 10 MB (413) via `readCappedBody`; the `~/.ezcoder` progress `fs.watch` handle is now closed on shutdown; the project-file glob search streams and bails after 50k entries. Closes three unbounded-memory/leak paths.
  - **Cap-divergence marker (gg-agent):** `capToolResults`/`capTurnToolResults` now stamp `ToolResult.capped = { originalChars, keptChars, scope }` when they trim, so the event-transcript vs model-input divergence is programmatically visible. Internal metadata only — never serialized to the provider.
  - **Empty-part serializer fix (gg-ai):** `toAnthropicMessages` no longer emits empty text parts (user `""`, user `{text:""}`, settled assistant `""`), eliminating live Anthropic 400 "text content blocks must be non-empty" failures.
  - **Tool-id remap fix (gg-ai):** `remapToolCallId` now strips the full `toolu_` prefix (`slice(6)`), mapping `toolu_01ABC` → clean `call_01ABC` instead of the lossy double-underscore `call__01ABC`.

- Updated dependencies
  - @prestyj/ai@5.22.1
  - @prestyj/agent@5.22.1
  - @prestyj/core@5.22.1

## 5.22.0

### Minor Changes

- Add Kimi (Moonshot) subscription usage tracking — the usage meter now reports Kimi For Coding plan quota (weekly + rate windows) alongside Anthropic and OpenAI.

### Patch Changes

- @prestyj/ai@5.22.0
- @prestyj/agent@5.22.0
- @prestyj/core@5.22.0

## 5.21.0

### Minor Changes

- Kimi K3 gains its full low/high/max thinking ladder with an endpoint-aware default (high on the Kimi For Coding OAuth endpoint, matching the official CLI's plan-usage profile; max on the public API), thinking can now be fully disabled via the nested toggle, and context compaction no longer blows past the model's window on oversized turns.

### Patch Changes

- @prestyj/ai@5.21.0
- @prestyj/agent@5.21.0
- @prestyj/core@5.21.0

## 5.20.5

### Patch Changes

- Require generated UIs to meet WCAG 2.2 Level AA and follow ADA-aligned accessibility practices.
  - @prestyj/ai@5.20.5
  - @prestyj/agent@5.20.5
  - @prestyj/core@5.20.5

## 5.20.4

### Patch Changes

- Teach the bundled UI skill to avoid generic soft semantic tint-on-tint treatments.
  - @prestyj/ai@5.20.4
  - @prestyj/agent@5.20.4
  - @prestyj/core@5.20.4

## 5.20.3

### Patch Changes

- Strengthen the bundled UI skill with consistent content rails, control spacing, and pointer focus guidance.
  - @prestyj/ai@5.20.3
  - @prestyj/agent@5.20.3
  - @prestyj/core@5.20.3

## 5.20.2

### Patch Changes

- 5fb6b62: Automatically enforce session retention across desktop, CLI, and chat-agent stores, compress inactive transcripts after seven days, and cap persisted tool output at 40,000 characters. Media is migrated to deduplicated adjacent assets with backward-compatible hydration and archived sessions remain discoverable and resumable through stale saved paths.
- Updated dependencies [f4b8ec7]
  - @prestyj/core@5.20.2
  - @prestyj/ai@5.20.2
  - @prestyj/agent@5.20.2

## 5.20.1

### Patch Changes

- Show up to 30 recent chat sessions while keeping coding history capped at 5.
  - @prestyj/ai@5.20.1
  - @prestyj/agent@5.20.1
  - @prestyj/core@5.20.1

## 5.20.0

### Minor Changes

- Harden agent completion, loop recovery, workspace writes, project instructions, and subagent concurrency.

### Patch Changes

- @prestyj/ai@5.20.0
- @prestyj/agent@5.20.0
- @prestyj/core@5.20.0

## 5.19.6

### Patch Changes

- Filter expected usage polling, cancellation, and tool validation failures from desktop error reports.
  - @prestyj/ai@5.19.6
  - @prestyj/agent@5.19.6
  - @prestyj/core@5.19.6

## 5.19.5

### Patch Changes

- Report sidecar, provider, tool, and subagent failures through the desktop Error Mom integration.
  - @prestyj/ai@5.19.5
  - @prestyj/agent@5.19.5
  - @prestyj/core@5.19.5

## 5.19.4

### Patch Changes

- Prevent Anthropic many-image requests from failing by resizing new and restored images to provider-safe dimensions.
  - @prestyj/ai@5.19.4
  - @prestyj/agent@5.19.4
  - @prestyj/core@5.19.4

## 5.19.3

### Patch Changes

- Updated dependencies [b6e7562]
  - @prestyj/ai@5.19.3
  - @prestyj/agent@5.19.3
  - @prestyj/core@5.19.3

## 5.19.2

### Patch Changes

- Reduce long-session token usage with calibrated context estimates and preserve full oversized command output for targeted recovery.
  - @prestyj/ai@5.19.2
  - @prestyj/agent@5.19.2
  - @prestyj/core@5.19.2

## 5.19.1

### Patch Changes

- Cut OpenAI token burn: percentage-only compaction thresholds on authoritative provider usage, a per-turn aggregate tool-result budget that trims parallel fan-out context bombs, cheap stale tool-output pruning (superseded reads and old outputs stubbed before compaction), and autopilot now suppresses the redundant Ideal self-review while Nolan owns verification.
  - @prestyj/ai@5.19.1
  - @prestyj/agent@5.19.1
  - @prestyj/core@5.19.1

## 5.19.0

### Minor Changes

- Add Grok 4.5 support and make Kimi prefer OAuth with automatic API-key fallback when plan usage is exhausted.

### Patch Changes

- @prestyj/ai@5.19.0
- @prestyj/agent@5.19.0
- @prestyj/core@5.19.0

## 5.18.0

### Minor Changes

- e00de5b: Add Kimi K3 as Moonshot's default model with its 1M-token multimodal registry metadata and endpoint-specific max-effort request handling for both the public API and Kimi Code OAuth. Keep Kimi K2.7 Code available as the dedicated coding alternative.

### Patch Changes

- Updated dependencies [e00de5b]
  - @prestyj/ai@5.18.0
  - @prestyj/core@5.18.0
  - @prestyj/agent@5.18.0

## 5.17.0

### Minor Changes

- a3916ff: Harden provider error handling, cancellation settlement, review evidence, LSP confidence, route-aware context limits, turn metrics, and durable child-agent recovery.

### Patch Changes

- Updated dependencies [a3916ff]
  - @prestyj/ai@5.17.0
  - @prestyj/agent@5.17.0
  - @prestyj/core@5.17.0

## 5.16.0

## 5.6.0

### Minor Changes

- Add evidence-led UI guidance and improve agent session reliability.

### Patch Changes

- @prestyj/ai@5.6.0
- @prestyj/agent@5.6.0
- @prestyj/core@5.6.0

## 5.5.0

### Minor Changes

- Add chat agents, async subagent orchestration, model upgrades, and reliability improvements.

### Patch Changes

- @prestyj/ai@5.5.0
- @prestyj/agent@5.5.0
- @prestyj/core@5.5.0

## 5.4.1

### Patch Changes

- Updated dependencies
  - @prestyj/ai@5.4.1
  - @prestyj/agent@5.4.1
  - @prestyj/core@5.4.1

## 5.4.0

### Minor Changes

- Sync upstream ezcoder (27 commits): add GPT-5.6 Sol/Terra/Luna models with the `max` reasoning ladder, fix Gemini GA model IDs (`gemini-3-flash`, `gemini-3.1-pro-preview`), add the subscription usage meter, make error hints UI-agnostic, and fix the sidecar bundler dropping transitive MCP deps.

### Patch Changes

- Updated dependencies
  - @prestyj/ai@5.4.0
  - @prestyj/agent@5.4.0
  - @prestyj/core@5.4.0

## 5.3.1

### Patch Changes

- Fix app task runs hanging when models enter plan mode; sync upstream framework changes.
- Updated dependencies
  - @prestyj/ai@5.3.1
  - @prestyj/agent@5.3.1
  - @prestyj/core@5.3.1

## 5.3.0

### Minor Changes

- Autopilot Nolan: add IGNORE verdict so non-work turns (small talk, git commits, read-only lookups) stop silently instead of forcing ALL_CLEAR; fix autopilot gating and per-project model pinning; render a NOLAN ON/OFF ASCII banner on toggle; fix footer dropdown z-index and the `--tools` flag drift.

### Patch Changes

- @prestyj/ai@5.3.0
- @prestyj/agent@5.3.0
- @prestyj/core@5.3.0

## 5.2.0

### Minor Changes

- Sync upstream ezcoder features: autopilot auto-review loop, Xiaomi API-Credits
  fallback with MiMo-V2.5-Pro-UltraSpeed, structured provider errors
  (headline/message/guidance), subagent tool allow-list enforcement, task
  auto-pruning, and Claude Sonnet 5. Fork distinctions (task list, monitor selector,
  branding) preserved.

### Patch Changes

- @prestyj/ai@5.2.0
- @prestyj/agent@5.2.0
- @prestyj/core@5.2.0

## 5.10.0

### Minor Changes

- Add OAuth subscription usage snapshots for Anthropic and OpenAI Codex.

### Patch Changes

- @prestyj/ai@5.10.0
- @prestyj/agent@5.10.0
- @prestyj/core@5.10.0

## 5.9.7

### Patch Changes

- Updated dependencies
  - @prestyj/core@5.9.7
  - @prestyj/ai@5.9.7
  - @prestyj/agent@5.9.7

## 5.9.6

### Patch Changes

- Retry read-only sub-agents on the active parent model when the cheaper model is unavailable.
  - @prestyj/ai@5.9.6
  - @prestyj/agent@5.9.6
  - @prestyj/core@5.9.6

## 5.9.5

### Patch Changes

- Add GPT-5.6 Sol, Terra, and Luna models to the registry; remove GPT-5.4, GPT-5.4 Mini, and GPT-5.3 Codex. Fix provider error hints to reference the model selector instead of CLI-only slash commands so they work in both the desktop app and the CLI.
  - @prestyj/ai@5.9.5
  - @prestyj/agent@5.9.5
  - @prestyj/core@5.9.5

## 5.9.4

### Patch Changes

- Auto-recover from context-overflow errors in the desktop app (request_too_large / 413) by wiring force-compaction + retry into AgentSession, add explicit 413 guidance, and rebrand user-facing error text to "EZ Coder".
  - @prestyj/ai@5.9.4
  - @prestyj/agent@5.9.4
  - @prestyj/core@5.9.4

## 5.9.3

### Patch Changes

- Fix Gemini models over Code Assist OAuth: use the GA IDs from gemini-cli (`gemini-3.1-flash-lite`, wire name `gemini-3-flash` for Gemini 3.5 Flash), add Gemini 3.1 Pro (Preview) to the registry, and surface account-gated 404s as a clear entitlement message with actionable guidance instead of a raw provider error body.
  - @prestyj/ai@5.9.3
  - @prestyj/agent@5.9.3
  - @prestyj/core@5.9.3

## 5.9.2

### Patch Changes

- Fix retroactive XP seeding so heavy prior users spread across levels 15-25 instead of all clamping onto level 15. Full credit up to level 15, then diminishing returns beyond, hard-capped at level 25.
  - @prestyj/ai@5.9.2
  - @prestyj/agent@5.9.2
  - @prestyj/core@5.9.2

## 5.9.1

### Patch Changes

- Updated dependencies
  - @prestyj/ai@5.9.1
  - @prestyj/agent@5.9.1
  - @prestyj/core@5.9.1

## 5.9.0

### Minor Changes

- Hash-anchored span edits and opt-in persistent bash session. The edit tool gains a `{ span, lines }` form: pin a line range by its line+hash anchors from a `read` with `anchors:true` and supply only the replacement lines — no retyping existing code, stale files rejected before any write. Benchmarked on Sonnet 5 at −19% output tokens overall and −76% on repetitive code, with equal correctness. The bash tool gains `persist: true`: commands run in a long-lived session shell where cd, env vars, and shell state survive across calls (~0.3ms vs ~6.4ms per-call overhead).

### Patch Changes

- @prestyj/ai@5.9.0
- @prestyj/agent@5.9.0
- @prestyj/core@5.9.0

## 5.8.8

### Patch Changes

- Fix transient Nolan sessions leaking to the session store (compact() and newSession() now respect the transient flag), harden autopilot verdict parsing to recover a buried line-start PROMPT keyword, and tighten Nolan's autopilot contract so reasoning prose never precedes the verdict.
  - @prestyj/ai@5.8.8
  - @prestyj/agent@5.8.8
  - @prestyj/core@5.8.8

## 5.8.7

### Patch Changes

- Cut MCP server memory: resolve stdio servers to their real bin (via the npx on-demand cache and sole-bin matching) instead of falling back to the ~90 MB npx wrapper per connection. Covers non-bundled defaults like zai and any user-added MCP.
  - @prestyj/ai@5.8.7
  - @prestyj/agent@5.8.7
  - @prestyj/core@5.8.7

## 5.8.6

### Patch Changes

- Fix autopilot leaking the raw HUMAN verdict reason and teach Nolan EZ Coder's own capabilities so his guidance is grounded in what the tool can actually do.
  - @prestyj/ai@5.8.6
  - @prestyj/agent@5.8.6
  - @prestyj/core@5.8.6

## 5.8.5

### Patch Changes

- Autopilot now tells EZ Coder when no human is watching: injected review prompts carry a situational-awareness preamble so the agent self-verifies its work and stops asking permission for safe, already-implied steps, while the transcript and resumed sessions still show Nolan's clean instruction.
  - @prestyj/ai@5.8.5
  - @prestyj/agent@5.8.5
  - @prestyj/core@5.8.5

## 5.8.4

### Patch Changes

- Route read-only scout sub-agents (recon/research) to each provider's fast/cheap model via `costTier`, cutting sub-agent latency and spend with no quality risk. Writers and default sub-agents keep the parent model.
  - @prestyj/ai@5.8.4
  - @prestyj/agent@5.8.4
  - @prestyj/core@5.8.4

## 5.8.3

### Patch Changes

- Fix Anthropic empty-args tool calls and underscore-path project discovery. Truncated tool-input JSON now surfaces as a retryable parse error instead of emitting a phantom `args:{}` call, and eager/fine-grained tool streaming is gated behind a default-off flag. Project discovery reads the real cwd from ezcoder session headers, so projects whose path contains an underscore no longer vanish from the picker.
  - @prestyj/ai@5.8.3
  - @prestyj/agent@5.8.3
  - @prestyj/core@5.8.3

## 5.8.2

### Patch Changes

- Ship deferred MCP tools, leaner prompts, and smoother retry recovery for faster coding-agent turns.
  - @prestyj/ai@5.8.2
  - @prestyj/agent@5.8.2
  - @prestyj/core@5.8.2

## 5.8.1

### Patch Changes

- Session resume now renders 1:1 with the live transcript: stale autopilot all-clear markers are deduped and range-clamped (no more duplicate Nolan bubbles bunching at the bottom of reopened sessions), queued steering prompts resume as clean bubbles without the internal wrapper, Nolan "Send to EZ Coder" labels, enhancer highlights, plan-mode banners, task headers, error rows, and compaction counts all persist and restore, and all-clear wording is deterministic across reopens.
  - @prestyj/ai@5.8.1
  - @prestyj/agent@5.8.1
  - @prestyj/core@5.8.1

## 5.8.0

### Minor Changes

- Autopilot now reviews submitted plans itself, auto-approves sound plans, requests revisions when needed, and starts implementation without a human blocker.

### Patch Changes

- @prestyj/ai@5.8.0
- @prestyj/agent@5.8.0
- @prestyj/core@5.8.0

## 5.7.0

### Minor Changes

- Add XP progression system: rank engine, git-based XP, persistent progress store, and sidecar progress endpoints powering the ezcoder-app rank badge, scorecard, and level-up celebrations.

### Patch Changes

- @prestyj/ai@5.7.0
- @prestyj/agent@5.7.0
- @prestyj/core@5.7.0

## 5.6.3

### Patch Changes

- Fix duplicate session files created on every resume — resuming now appends to the original session file instead of forking a byte-identical copy each time.
  - @prestyj/ai@5.6.3
  - @prestyj/agent@5.6.3
  - @prestyj/core@5.6.3

## 5.6.2

### Patch Changes

- Optimize Nolan mentor/autopilot prompt caching: fold static project context (CLAUDE.md/AGENTS.md) into the cached system prompt instead of resending it uncached every turn, and force long cache retention on Nolan sessions independent of the user's global speed profile.
  - @prestyj/ai@5.6.2
  - @prestyj/agent@5.6.2
  - @prestyj/core@5.6.2

## 5.6.1

### Patch Changes

- Fix Nolan autopilot gating, stranded prompt handling, and Nolan model selection in the app sidecar.
  - @prestyj/ai@5.6.1
  - @prestyj/agent@5.6.1
  - @prestyj/core@5.6.1

## 5.6.0

### Minor Changes

- Autopilot Nolan now has an IGNORE verdict for turns that were never real work (small talk, answered questions, mechanical git ops like commit/push), so trivial turns no longer produce a pointless "all clear" in the transcript.

### Patch Changes

- @prestyj/ai@5.6.0
- @prestyj/agent@5.6.0
- @prestyj/core@5.6.0

## 5.5.1

### Patch Changes

- Fix subagent tool allow-list crashing in the desktop app: the JSON-mode arg parser in `app-sidecar.ts` was missing the `--tools` flag, so any named agent with a `tools:` allow-list (bee, owl, researcher, worker) failed to spawn with "Unknown option '--tools'".
  - @prestyj/ai@5.5.1
  - @prestyj/agent@5.5.1
  - @prestyj/core@5.5.1

## 5.5.0

### Minor Changes

- Add autopilot Nolan auto-review loop: after each turn a separate read-only Nolan reviewer judges the work and either sends EZ Coder back in with a fresh prompt, calls it all-clear, or flags for a human. Also auto-prune completed tasks from the sidecar task list.

### Patch Changes

- @prestyj/ai@5.5.0
- @prestyj/agent@5.5.0
- @prestyj/core@5.5.0

## 5.4.3

### Patch Changes

- Enforce subagent `tools:` frontmatter as an allowlist, raise the subagent turn cap to 50 with a clear cut-off signal when it's hit, and phrase `/init` and task-handoff notices for the ezcoder-app UI instead of CLI keybinds.
  - @prestyj/ai@5.4.3
  - @prestyj/agent@5.4.3
  - @prestyj/core@5.4.3

## 5.4.2

### Patch Changes

- Auto-continue once when a tool call fails 3x with completely empty arguments (a provider stream glitch, not a model schema mistake), and correctly attribute the resulting error to the provider instead of mislabeling it a ezcoder bug.
  - @prestyj/ai@5.4.2
  - @prestyj/agent@5.4.2
  - @prestyj/core@5.4.2

## 5.4.1

### Patch Changes

- Fix ezcoder-app auto-compaction not reserving headroom for a model's real output budget (e.g. GPT-5.5 over Codex OAuth: 272K window, up to 128K output), which let context grow until the provider rejected the turn with "exceeds the context window"; also fix the app's context-window footer to use the correct transport-specific window (Codex OAuth vs public API).
  - @prestyj/ai@5.4.1
  - @prestyj/agent@5.4.1
  - @prestyj/core@5.4.1

## 5.4.0

### Minor Changes

- Re-enable Claude Fable 5 in the model selector, and show clean, provider-attributed error messages (headline + guidance + reset time for usage limits) instead of raw JSON error blobs from providers like Xiaomi MiMo.

### Patch Changes

- @prestyj/ai@5.4.0
- @prestyj/agent@5.4.0
- @prestyj/core@5.4.0

## 5.3.0

### Minor Changes

- Add Xiaomi MiMo-V2.5-Pro-UltraSpeed, served over a separate API Credits endpoint. Xiaomi auth now supports both the existing Token Plan key and a new API Credits key — `mimo-v2.5-pro`/`mimo-v2.5` prefer the Token Plan and fall back to API Credits when that's all that's configured, while UltraSpeed requires API Credits. `ezcoder login` and the desktop login modal both let you choose which endpoint to authenticate with.

### Patch Changes

- @prestyj/ai@5.3.0
- @prestyj/agent@5.3.0
- @prestyj/core@5.3.0

## 5.2.0

### Minor Changes

- Add Claude Sonnet 5 (`claude-sonnet-5`, 1M context, 128k output, adaptive thinking) replacing Sonnet 4.6, and fix the Anthropic non-streaming fallback so it no longer trips the SDK's "Streaming is required for operations that may take longer than 10 minutes" pre-flight throw on large max_tokens.

### Patch Changes

- @prestyj/ai@5.2.0
- @prestyj/agent@5.2.0
- @prestyj/core@5.2.0

## 5.1.2

### Patch Changes

- Add a tool-steering clause that nudges the model to batch independent read-only calls (read, grep, ls, find) into one turn, cutting round-trips since tool execution is already parallel.
  - @prestyj/ai@5.1.2
  - @prestyj/agent@5.1.2
  - @prestyj/core@5.1.2

## 5.1.1

### Patch Changes

- Fix stale daemon auth cache blocking model switch after a native API-key write. The desktop app writes provider API keys natively (Rust → `~/.ezcoder/auth.json`), bypassing the long-lived Node daemon whose `AuthStorage` cached the file on first load. As a result a newly added provider (e.g. Xiaomi/MiMo) never appeared in `/models` and could not be selected. `AuthStorage` gains a `reload()` that re-reads from disk, and the daemon calls it on `/models`, `/model`, and `/auth/status`. Also refresh the Xiaomi provider description to list MiMo-V2.5-Pro, MiMo-V2.5-Pro UltraSpeed, and MiMo-V2.5.
- Updated dependencies
  - @prestyj/core@5.1.1
  - @prestyj/ai@5.1.1
  - @prestyj/agent@5.1.1

## 5.1.0

### Minor Changes

- Add the **@Nolan** read-only mentor agent (rebranded from upstream's @Nolan). Talk to Nolan with `@Nolan <prompt>` in the desktop app: a second, read-only `AgentSession` per window that understands what you're building and hands back short, runnable prompts plus blunt mentorship — he recommends, EZ Coder executes. Includes session persistence, model-switch sync, rotating input placeholders, and a tinted UI. Also refactors the app's event handling into `useAgentEvents` + `useNolanMentor` hooks with run-end project-task reconciliation.

### Patch Changes

- @prestyj/ai@5.1.0
- @prestyj/agent@5.1.0
- @prestyj/core@5.1.0

## 5.0.1

### Patch Changes

- Updated dependencies [a013269]
  - @prestyj/ai@5.0.1
  - @prestyj/core@5.0.1
  - @prestyj/agent@5.0.1

## 5.1.1

### Patch Changes

- Fix the ezcoder-app Nolan mentor sidecar so it follows model switches after it has been created.
  - @prestyj/ai@5.1.1
  - @prestyj/agent@5.1.1
  - @prestyj/core@5.1.1

## 5.1.0

### Minor Changes

- Add Nolan Grout, a read-only mentor agent: a second AgentSession scoped by an `allowedTools` allow-list plus an `allowedMcpServers` whitelist (kencode-search) so it can research real code but never mutate the repo, with its advisory turns persisted alongside the build session as non-LLM custom entries that survive resume and compaction.

### Patch Changes

- @prestyj/ai@5.1.0
- @prestyj/agent@5.1.0
- @prestyj/core@5.1.0

## 5.0.0

### Major Changes

- Remove the `ezcoder pixel` error-tracking command and all ez-pixel SDK packages (breaking CLI change), and add test-drift detection to the ideal-review hook so editing a source file whose sibling test was left untouched now prompts the agent to update the stale test.

### Patch Changes

- @prestyj/ai@5.0.0
- @prestyj/agent@5.0.0
- @prestyj/core@5.0.0

## 4.15.0

### Minor Changes

- Add `code_search` AST-aware tool (TS/JS symbol chunking + BM25 ranking) and opt-in hashline anchors for read/edit (stale-edit rejection via line+hash guard).

### Patch Changes

- @prestyj/ai@4.15.0
- @prestyj/agent@4.15.0
- @prestyj/core@4.15.0

## 4.14.3

### Patch Changes

- Fix queued messages overriding the original task: mid-run steering prompts are now framed as concurrent instructions so the agent folds them into the current work instead of abandoning the original objective.
  - @prestyj/ai@4.14.3
  - @prestyj/agent@4.14.3
  - @prestyj/core@4.14.3

## 4.14.2

### Patch Changes

- Add prompt-enhancer sidecar capability with project-stack-aware terminology, and harden image attachments — malformed/unsupported images (e.g. a bad .ico) now degrade to a file note instead of failing the whole turn.
  - @prestyj/ai@4.14.2
  - @prestyj/agent@4.14.2
  - @prestyj/core@4.14.2

## 4.14.1

### Patch Changes

- Fix Anthropic 1h prompt-cache TTL by sending the extended-cache-ttl beta header on the streaming and prewarm paths, so `cacheRetention: "long"` no longer silently falls back to the 5-minute default.
  - @prestyj/ai@4.14.1
  - @prestyj/agent@4.14.1
  - @prestyj/core@4.14.1

## 4.14.0

### Minor Changes

- Add Sakana Fugu provider (Fugu, Fugu Ultra) with API-key login, high/xhigh reasoning, and a silent-reasoning stream-timeout extension.

### Patch Changes

- @prestyj/ai@4.14.0
- @prestyj/agent@4.14.0
- @prestyj/core@4.14.0

## 4.13.3

### Patch Changes

- Fix orphaned queued messages after an abort — drain the post-abort queue even when the run was interrupted, so a reprompt during async teardown isn't stranded.
  - @prestyj/ai@4.13.3
  - @prestyj/agent@4.13.3
  - @prestyj/core@4.13.3

## 4.13.2

### Patch Changes

- Add tool-call and error logging to the ezcoder-app sidecar event bridge so fatal "invalid tool arguments" aborts leave a forensic trail in `~/.ezcoder/ezcoder-app-sidecar.log` (tool name, isError, result preview, and agent error events) instead of failing silently.
  - @prestyj/ai@4.13.2
  - @prestyj/agent@4.13.2
  - @prestyj/core@4.13.2

## 4.13.1

### Patch Changes

- Spawn dependency-backed stdio MCP servers (e.g. the default kencode-search)
  directly via `node <binScript>` instead of `npx -y <pkg>`, removing the ~100 MB
  `npm exec` wrapper process per MCP connection. Non-dependency / non-npx servers
  pass through unchanged.

  Also ships content-aware compression for bash/task_output truncation (preserves
  errors over blind tail slices) and the ezcoder-app shared-daemon backend refactor.
  - @prestyj/ai@4.13.1
  - @prestyj/agent@4.13.1
  - @prestyj/core@4.13.1

## 4.13.0

### Minor Changes

- Update system prompt talk section for ADHD-readable responses

  Rewrite `renderTalkSection()` so every reply leads with the outcome word
  (Fixed/Done/Broken/Failed), enforces bottom-line-first scanning, one idea
  per line, pick-don't-menu, concrete metrics, no unresolved it-depends, and
  affirmative phrasing. Designed for fast scanning and low working memory.

### Patch Changes

- Updated dependencies
  - @prestyj/ai@4.13.0
  - @prestyj/agent@4.13.0
  - @prestyj/core@4.13.0

## 4.12.2

### Patch Changes

- Fix Windows sidecar crash: the session-folder name encoder (`encodeCwd`) now strips Windows extended-length path prefixes (`\\?\` and `\\?\UNC\`) and all reserved filename characters (`<>:"|?*`). Previously, Windows canonicalized cwds (`\\?\C:\Users\brams`) produced illegal folder names containing `?`, causing `mkdir` ENOENT and a fatal sidecar crash on startup — blocking OAuth/login for all Windows users.
- Updated dependencies
  - @prestyj/ai@4.12.2
  - @prestyj/agent@4.12.2
  - @prestyj/core@4.12.2

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

- Updated dependencies
  - @prestyj/ai@4.12.1
  - @prestyj/agent@4.12.1
  - @prestyj/core@4.12.1

## 4.12.0

### Minor Changes

- Add generate_image tool: generate and edit images via OpenAI gpt-image-2 through the Codex backend. Conditionally registered when OpenAI is connected. Includes inline image preview in transcript, shimmering skeleton placeholder during generation, 1:1 history reconstruction for tool-produced images and sub-agent groups on session resume, and image path exposure for multi-turn editing.

### Patch Changes

- Updated dependencies
  - @prestyj/ai@4.12.0
  - @prestyj/agent@4.12.0
  - @prestyj/core@4.12.0

## 4.11.3

### Patch Changes

- 1c37b11: Persist model + thinking selection per-project (per window) across app restarts.

  Previously every window's sidecar wrote its model choice to a single shared
  `defaultModel`/`defaultProvider` slot in `~/.ezcoder/settings.json`, so switching a
  model in one window clobbered the selection for all others — and on restart
  every window defaulted to the last-written model (or fell back to the provider
  default when that provider wasn't logged in). Model + thinking preferences are
  now stored keyed by project cwd in `~/.ezcoder/ezcoder-app.json` and read first on boot;
  the global slot is kept only as a fallback for never-opened projects.
  - @prestyj/ai@4.11.3
  - @prestyj/agent@4.11.3
  - @prestyj/core@4.11.3

## 4.11.2

### Patch Changes

- a2da1f8: Fix app subagents to inherit the active model at spawn time and render completed plan-step markers cleanly.
  - @prestyj/ai@4.11.2
  - @prestyj/agent@4.11.2
  - @prestyj/core@4.11.2

## 4.11.1

### Patch Changes

- Fix sub-agents hanging until timeout when spawned from a host whose `argv[1]`
  isn't the CLI entry (e.g. the desktop app's sidecar). The subagent tool now
  resolves `dist/cli.js` relative to its own module instead of trusting
  `process.argv[1]`, so sub-agents run and stream NDJSON correctly in every host.
  - @prestyj/ai@4.11.1
  - @prestyj/agent@4.11.1
  - @prestyj/core@4.11.1

## 4.11.0

### Patch Changes

- Updated dependencies
  - @prestyj/core@4.11.0
  - @prestyj/ai@4.11.0
  - @prestyj/agent@4.11.0

## 4.10.2

### Patch Changes

- Fix duplicated transcript text and random whitespace in the terminal UI. The
  bottom-pinned shrink-backfill repaint reconstructed the on-screen transcript by
  re-serializing history (markdown re-render + wrapAnsi); when a row's visual
  width diverged from the terminal (wide emoji, bold/italic markdown, CJK) the
  rebuilt row count disagreed with ink's frame math, causing the repaint to
  overlap still-present rows (duplicate lines) or pad short with blank rows
  (injected whitespace). It fired on nearly every turn. The repaint is now
  disabled by default — ink falls back to a cursor-up pad-consume that never
  repaints content — eliminating both failure modes. Opt back in with
  `GG_SHRINK_BACKFILL=1`. Also adds `[scrollback]` debug logging across every
  native-scrollback write path.
  - @prestyj/ai@4.10.2
  - @prestyj/agent@4.10.2
  - @prestyj/core@4.10.2

## 4.10.1

### Patch Changes

- Fix `ezcoder continue` resuming the newest-created session instead of the one you last spoke in (now sorts by last-message activity), and fix inline-image scrollback corruption (base64 spew, duplicated lines, and misaligned images) by bailing the shrink-backfill text repaint when the transcript contains an image.
  - @prestyj/ai@4.10.1
  - @prestyj/agent@4.10.1
  - @prestyj/core@4.10.1

## 4.10.0

### Minor Changes

- Update Kimi to K2.7 (`kimi-k2.7-code`) as the Moonshot default model, replacing Kimi K2.6 across the registry, CLI, login UI, and docs.

  Harden Kimi OAuth token refresh so it no longer silently falls back to a paid Moonshot API key: refresh reuses the existing refresh token when the server doesn't rotate it, tokens are renewed proactively before expiry (60s skew), `baseUrl` is preserved across refreshes, and a genuinely-dead OAuth credential now logs a warning instead of switching billing silently.

### Patch Changes

- Updated dependencies
  - @prestyj/ai@4.10.0
  - @prestyj/agent@4.10.0
  - @prestyj/core@4.10.0

## 4.9.1

### Patch Changes

- Fix blank rows being reserved above short live content during streaming. The
  live-area height estimate over-counted non-text rows (slash-command info lines,
  tool/step markers), which falsely clamped the live area to its full budget and
  bottom-anchored the content — leaving a block of empty rows above it until the
  rows flushed to history. The estimate is now biased low; Ink's
  clipFrameToTerminalHeight remains the authoritative overflow backstop.
  - @prestyj/ai@4.9.1
  - @prestyj/agent@4.9.1
  - @prestyj/core@4.9.1

## 4.9.0

### Minor Changes

- Add LSP inline diagnostics to the edit/write tools. Successful edits now append
  compiler-grade error diagnostics (`Diagnostics in src/a.ts (informational …):
L42:7 Type 'string' is not assignable …`) so the model self-corrects type errors
  in the same turn. `typescript-language-server` + `typescript` ship bundled, so
  TS/JS diagnostics work for every user with zero setup; Python/Go/Rust/C servers
  are auto-detected from the project or PATH when present. Servers spawn lazily,
  are time-budgeted, and degrade silently — output is byte-identical when no server
  is available. Opt out with `"lspDiagnostics": false` in `~/.ezcoder/settings.json`.

### Patch Changes

- @prestyj/ai@4.9.0
- @prestyj/agent@4.9.0
- @prestyj/core@4.9.0

## 4.8.7

### Patch Changes

- Fix the intermittent blank-row block appearing right before the agent's final response: the patched ink's bottom-anchor pad debt left over from a run-end frame shrink is now reclaimed when the anchor deactivates (ink fork 6.8.0-gg.2). Also: oversized flushed assistant prefixes leave live state immediately, and null-rendering items no longer inflate the live-area clamp estimate.
  - @prestyj/ai@4.8.7
  - @prestyj/agent@4.8.7
  - @prestyj/core@4.8.7

## 4.8.6

### Patch Changes

- Fix message vanish on slash-command submit: queueFlush now mirrors flushed rows into sessionStore.history synchronously so the patched ink's bottom-pinned repaint (menu close, resize) redraws from a current transcript. Also track /theme switches live so closure-level repaint serializers always use the active theme, not the startup theme.
  - @prestyj/ai@4.8.6
  - @prestyj/agent@4.8.6
  - @prestyj/core@4.8.6

## 4.8.5

### Patch Changes

- Ship the patched Ink rendering engine to npm installs. The TUI's footer-anchor and scrollback fixes live in a patched ink build that pnpm's patchedDependencies only applied inside the workspace — npm users silently got vanilla ink. ezcoder's ink dependency is now an npm alias to the published @kenkaiiii/ink fork, so every install (npm, pnpm, yarn, bun) gets the fixed renderer with no install scripts.
  - @prestyj/ai@4.8.5
  - @prestyj/agent@4.8.5
  - @prestyj/core@4.8.5

## 4.8.4

### Patch Changes

- Fix footer jumps and scrollback whitespace/duplication in the scrollback-mode TUI. The patched Ink now folds transcript flushes atomically into frame writes (insertBeforeFrame), anchors the frame bottom with reclaimable pad debt while the agent runs, clips frames to terminal height, and repaints in place (cursor home + eraseDown) for bottom-pinned idle height changes like the slash-command menu — so the footer stays pinned, responses have no phantom gaps, and scrollback receives no duplicate banner/prompt copies.
  - @prestyj/ai@4.8.4
  - @prestyj/agent@4.8.4
  - @prestyj/core@4.8.4

## 4.8.3

### Patch Changes

- Fix oversized pinned assistant items being cut off in the live area: flush tall finalized items (cumulative over the pinned set) to scrollback, and keep the height-clamp slice from starting on a blank line so the ⏺ prefix stays aligned.
  - @prestyj/ai@4.8.3
  - @prestyj/agent@4.8.3
  - @prestyj/core@4.8.3

## 4.8.2

### Patch Changes

- Fix TUI scrollback corruption from streaming markdown tables and inline images: table-aware live-region row estimation, pending-table height clamping and partial-row hold-back in the markdown renderer, and fixed-height inline image blocks so Ink's live-frame erase math stays in sync (no more orphaned ⏺ rows).
  - @prestyj/ai@4.8.2
  - @prestyj/agent@4.8.2
  - @prestyj/core@4.8.2

## 4.8.1

### Patch Changes

- Fix ENOSPC crash when session transcript writes fail (disk full) — persistence now fails soft with a one-time warning instead of killing the live session. Add automatic session transcript pruning via new `sessionRetentionDays` setting (default 30 days, 0 disables).
  - @prestyj/ai@4.8.1
  - @prestyj/agent@4.8.1
  - @prestyj/core@4.8.1

## 4.8.0

### Patch Changes

- Updated dependencies
  - @prestyj/ai@4.8.0
  - @prestyj/core@4.8.0
  - @prestyj/agent@4.8.0

## 4.7.0

### Minor Changes

- Add `task_send` tool for interactive control of background processes. Background processes started with `run_in_background` now spawn with a stdin pipe, and the agent can answer prompts, drive REPLs, and feed scaffolders via `task_send` (with optional Enter/EOF), pairing with the existing `task_output`/`task_stop` tools.

### Patch Changes

- @prestyj/ai@4.7.0
- @prestyj/agent@4.7.0
- @prestyj/core@4.7.0

## 4.6.3

### Patch Changes

- Updated dependencies
  - @prestyj/ai@4.6.3
  - @prestyj/agent@4.6.3
  - @prestyj/core@4.6.3

## 4.6.2

### Patch Changes

- Fix OpenAI OAuth account switching by adding prompt=login to authorize URL. Previously, re-running `ezcoder login` with OpenAI would silently re-approve the cached browser session, preventing users from switching accounts.
- Updated dependencies
  - @prestyj/core@4.6.2
  - @prestyj/ai@4.6.2
  - @prestyj/agent@4.6.2

## 4.6.1

### Patch Changes

- Updated dependencies
  - @prestyj/ai@4.6.1
  - @prestyj/agent@4.6.1
  - @prestyj/core@4.6.1

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

### Patch Changes

- Updated dependencies
  - @prestyj/ai@4.6.0
  - @prestyj/agent@4.6.0
  - @prestyj/core@4.6.0

## 4.5.0

### Minor Changes

- Add native video analysis for Kimi K2.6, Gemini, and MiniMax. Attached and read videos are sent to the model in its required format (Kimi file-service upload, Gemini inlineData, MiniMax base64), with per-model size caps and automatic ffmpeg compression for oversized clips. Non-video models now show a clean "this model can't analyze video" message instead of an opaque provider error, and Kimi OAuth login was fixed to pass the coding-endpoint client identity.

### Patch Changes

- @prestyj/ai@4.5.0
- @prestyj/agent@4.5.0
- @prestyj/core@4.5.0

## 4.4.0

### Patch Changes

- Updated dependencies [9e381ad]
  - @prestyj/core@4.4.0
  - @prestyj/ai@4.4.0
  - @prestyj/agent@4.4.0
