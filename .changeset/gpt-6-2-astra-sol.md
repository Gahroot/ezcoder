---
"@prestyj/ai": minor
"@prestyj/core": minor
"@prestyj/cli": minor
"@prestyj/boss": minor
---

Add OpenAI GPT-6.2 Astra and GPT-6.2 Sol (released 2026-11-17), each with a
Codex Fast tier. GPT-6.2 Sol replaces GPT-6.1 Sol and is the new default OpenAI
model; on the ChatGPT-plan (Codex) route it gets a 500K context window, Astra
272K, and both get 1.05M on the public API. Both use the low → ultra reasoning
ladder. GPT-6.1 Sol is retired: a saved session on it falls back to the OpenAI
default on next start. GPT-6.1 Terra stays, since 6.2 has no Terra.
