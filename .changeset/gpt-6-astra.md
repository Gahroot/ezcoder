---
"@kenkaiiii/gg-ai": minor
"@kenkaiiii/gg-core": minor
"@kenkaiiii/ggcoder": minor
"@kenkaiiii/gg-boss": minor
---

Add GPT-6 Astra (`gpt-6-astra`, released 2026-09-03) to the model registry — 1.05M context on the public Responses API, 272K on the ChatGPT OAuth/Codex route, 128k output, text+image input, $10/$50 MTok with cache reads at $1/MTok. It takes the full six-rung Codex effort ladder (low → medium → high → xhigh → max → ultra) and uses the same responses-lite transport and `prompt_cache_options` cache shape as the GPT-5.6 family; at `ultra` it receives the proactive async-subagent orchestration prompt, matching its `multi_agent v2` catalog entry.

Astra is still rolling out (`visibility: hide` in OpenAI's Codex catalog), so accounts without access get the existing "not in the current Codex catalog" hint, which now names Astra among the alternatives. Through a plain OpenAI API key, OpenAI requires the Responses API for tool calling on Astra, so the Chat Completions path stays text-only — the OAuth Codex route is the supported way to run it as an agent.
