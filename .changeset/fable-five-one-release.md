---
"@kenkaiiii/gg-ai": minor
"@kenkaiiii/gg-core": minor
"@kenkaiiii/ggcoder": minor
"@kenkaiiii/gg-boss": minor
---

Add Claude Fable 5.1 (`claude-fable-5-1`, released 2026-09-01) to the model registry — 1M context, 128k output, image input, always-on adaptive thinking on the low→max ladder (no xhigh), $10/$50 MTok with cache reads at $0.25/MTok. It replaces Fable 5, which is retired from the registry and the model picker — a session still pinned to it falls back to the provider default on next start. Fable 5.1 rejects forced tool use (`tool_choice` `any`/`tool`) with a 400; gg-coder only ever sends `auto`/`none`, so no call path changes.

The login screen now derives its provider rows from `AUTH_PROVIDERS` instead of keeping a second hardcoded copy, and a new test pins every provider description to the model registry — which caught two stale ones: Z.AI now lists GLM-5.3-Flash alongside GLM-5.3, and OpenRouter names Qwen3.6-Plus rather than just "multi-provider gateway".
