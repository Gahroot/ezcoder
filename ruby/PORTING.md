# Porting notes: ezcoder (TypeScript) → EZ Agent (Ruby)

This gem set is a faithful port of ezcoder's reusable core and media-master's
hardened variant. This document maps the TS source to the Ruby modules and
records the decisions that aren't 1:1.

## Module map

| ezcoder / media-master (TS) | Ruby |
|---|---|
| `@prestyj/ai` `stream()` dispatch | `EZLLM.stream(...) { \|event\| }` (`ez_llm/lib/ez_llm.rb`) |
| `ai/providers/openai.ts` + `consume-stream.ts` | `ez_llm/providers/openai_compatible.rb` + `ez_llm/sse.rb` |
| `ai/providers/anthropic.ts` | `ez_llm/providers/anthropic.rb` |
| `ai/providers/gemini.ts` | `ez_llm/providers/gemini.rb` |
| `ai/providers/transform.ts` | `ez_llm/transform.rb` |
| `ai/types.ts` ContentBlock/events | `ez_llm/types.rb` + `ez_llm/event.rb` |
| `ai/errors.ts` + agent-loop classifiers | `ez_llm/errors.rb` (+ `error.rb`, `provider_error.rb`) |
| Zod schema → JSON Schema | `ez_llm/tool_schema.rb` (param DSL → JSON Schema) |
| `model-registry.ts` | `ez_llm/model_registry.rb` |
| `provider-registry.ts` | `ez_llm/provider_registry.rb` + `providers.rb` |
| `@prestyj/agent` `agentLoop` / media-master `loop.ts` | `ez_agent/loop.rb` |
| `AgentTool` + `ToolContext` | `ez_agent/tool.rb` + `tool_context.rb` |
| `agentTools/index.ts` merge + dispatch | `ez_agent/tool_registry.rb` |
| `toolRunner.ts` | `ez_agent/tool_runner.rb` |
| `untrustedContent.ts` | `ez_agent/untrusted.rb` (optional) |
| `toolGate.ts` + `toolPolicy.ts` | `ez_agent/approval_gate.rb` + `tool_policy.rb` (optional) |
| `AbortSignal` | `ez_agent/cancellation.rb` (cooperative token) |
| `AgentEvent` + `onEvent` | `ez_agent/event.rb` + block/callback |
| message-repair helpers in `agent-loop.ts` | `ez_agent/message_repair.rb` |
| tool-result truncation | `ez_agent/truncation.rb` |
| async generator (`yield*`) | blocking method + `yield` (consumer owns concurrency) |

## Decisions that aren't 1:1

- **No async generators.** `loop.ts` is an `async function*` yielding events.
  Ruby uses a blocking `Loop#run(messages:, &on_event)` that `yield`s each event
  and returns the final `Result`. `run_enum` gives an `Enumerator` for the
  iterable half. The consumer owns concurrency (inline / Thread / Fiber / job).

- **Cancellation without AbortSignal.** `EZAgent::Cancellation` is a cooperative
  token (`#aborted?`, `#abort!`, `#check!`, `#on_abort`). The loop checks it at
  turn boundaries and before each tool; `ToolRunner` honors it. Where the flag
  lives (memory, Redis, DB) is the consumer's business.

- **HTTP via `net/http`.** TS used vendor SDKs / `fetch` with no Ruby analog.
  `EZLLM::HTTP` wraps `Net::HTTP` for streaming (chunked body → `SSE::Reader`)
  and buffered (non-streaming fallback) requests. Keeps core dependency-light.

- **Schema conversion is hand-rolled.** ezcoder owns its Zod→JSON-Schema
  converter (incl. Anthropic's root-object rules: root must be `type: object`,
  no top-level `oneOf`/`anyOf`/`allOf`). We port that intent with a `param` DSL
  → JSON Schema and the same root-normalization (`ToolSchema.normalize_root_for_anthropic`).

- **Per-tenant credentials.** `StreamOptions.apiKey`/`baseUrl` per call → Ruby
  `EZLLM.stream(..., api_key:, base_url:)` and `Loop#run(credentials:)`. The
  `credentials:` arg accepts a Hash or a `->(provider) { {...} }` resolver, so
  multi-tenant + multi-provider falls out for free. No global key state.

- **Value objects.** TS discriminated unions of interfaces → Ruby `Data.define`
  with a `#type` symbol, dispatched via `case event.type` or pattern matching.

- **Approval gate is synchronous from core's view.** The loop calls
  `approval.request(...) → :allow/:deny/:always_allow`. HOW that decision is
  obtained is the consumer's `decide:` callable — prompt a terminal inline, or
  block on Redis/DB until a controller records a click (the media-master
  pattern). No gate ⇒ everything auto-allowed (ezcoder's default trust model).

## What's always-on vs. optional

**Always on** (pure, framework-free, already proven in TS):
- Loop recovery: turn/continuation budgets, overload/rate-limit backoff,
  stream-stall → non-streaming fallback, empty-response retry, context-overflow
  compaction hook, tool-pairing + thinking-block repair, pause-turn handling.
- ToolRunner: fault isolation (raise → `{error}` JSON), per-tool timeout,
  redacted/truncated input logging, result classification.
- Tool-result truncation (head 70% / tail 30%) and the sliding budgets.

**Optional** (security posture is the consumer's call, off by default):
- `ToolPolicy` + `ApprovalGate` — per-action human-in-the-loop.
- `Untrusted` fencing — wrap third-party tool output before it enters history;
  applied only to tools marked `untrusted!` when the loop has `fence_untrusted: true`.

## Out of scope for v1

- Autonomous/cron scheduling (the loop's steering/follow-up hooks exist, but no
  scheduler ships). `ApprovalGate` does support a `:cron` mode for the gate
  semantics.
- Any Rails/ActionCable/job code — a separate optional adapter gem, built after
  core is proven. **Step 19 (the Rails adapter) is now implemented** as the
  `ez_agent-rails` engine (persistence + RunJob + Turbo/ActionCable streaming +
  HITL gate + install generator + demo UI); see `ez_agent-rails/README.md`.
- MCP client, subagents, image/video attachment pipelines (the model registry
  already declares image/video caps so the door is open).

## Testing approach

End-to-end provider tests replay **recorded SSE over a real local HTTP server**
(`spec/support/fake_http_server.rb`) so the actual `Net::HTTP` + `SSE::Reader`
transport is exercised — without adding WebMock/VCR as a dependency (which would
violate the dependency-light non-negotiable). The agent loop is tested against a
scripted in-process provider registered into the `EZLLM` registry.
