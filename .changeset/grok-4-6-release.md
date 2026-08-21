---
"@kenkaiiii/gg-ai": minor
"@kenkaiiii/gg-core": minor
"@kenkaiiii/ggcoder": minor
"@kenkaiiii/gg-boss": minor
---

Add Grok 4.6 (`grok-4.6`, released 2026-08-12) to the model registry and make it the xAI default — 500K context, image input, $2/$6 MTok (under 200K prompt tokens), and a `reasoning_effort` ladder that adds a new `xhigh` top rung (`low`/`medium`/`high` default/`xhigh`), which `XAI_THINKING_LEVELS` now exposes; thinking starts at `xhigh`. Grok 4.5 stays registered as a legacy option, still capped at `high` since it rejects `xhigh`. The OpenAI-compatible transport needs no changes — `xhigh` passes through `toOpenAIReasoningEffort` unchanged — so both the public API and the Grok CLI OAuth proxy serve the new model; CLI/app login defaults point at `grok-4.6`.
