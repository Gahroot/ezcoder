---
"@kenkaiiii/gg-ai": minor
"@kenkaiiii/gg-core": minor
"@kenkaiiii/ggcoder": minor
"@kenkaiiii/gg-boss": minor
---

Add GPT-6 Sol (`gpt-6-sol`) and GPT-6 Luna (`gpt-6-luna`), released 2026-09-22, and retire the GPT-5.6 family (Sol, Terra, Luna). There is no GPT-6 Terra — OpenAI's Codex catalog upgrades 5.6 Terra to 6 Sol. Both new models get 1.05M context on the public Responses API and 272K on the ChatGPT OAuth/Codex route, 128K output, text+image input, and the responses-lite transport. Sol costs $2/$10 per MTok, defaults to `medium` effort, and runs the full ladder up to `ultra`, where it gets the proactive async-subagent orchestration prompt. Luna costs $0.10/$0.50 per MTok, defaults to `medium`, and tops out at `max`.

GPT-6 Sol is now the OpenAI default (registry, CLI, benchmarks), and GPT-6 Luna is the fast model for subagents. The login hub, footer names, README, and the "not in catalog" error hint list GPT-6 Astra, Sol, and Luna. A saved session still on a GPT-5.6 id falls back to the provider default on next start.
