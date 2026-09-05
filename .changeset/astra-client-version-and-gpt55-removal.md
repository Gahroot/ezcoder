---
"@kenkaiiii/gg-ai": minor
"@kenkaiiii/gg-core": minor
"@kenkaiiii/ggcoder": minor
"@kenkaiiii/gg-boss": minor
---

Fix GPT-6 Astra on the ChatGPT OAuth route. OpenAI gates Astra on the Codex client version (`minimal_client_version: 0.153.0`) and rejected our `0.144.1` header with "requires a newer version of Codex"; we now advertise `0.153.4`, the current openai/codex release. When a future model is gated the same way, the error guidance says plainly that GG Coder needs updating and to switch model meanwhile, instead of echoing OpenAI's "upgrade the app or CLI" as if it were the user's problem.

Remove GPT-5.5 from the model registry, footers, login hub, README, and CLI defaults (OpenAI now defaults to GPT-5.6 Sol everywhere, matching the registry). Sync the desktop login hub descriptions with the registry for every provider (Claude Fable 5.1, GPT-6 Astra, GLM-5.3-Flash, OpenRouter Qwen3.6-Plus). Drop the last slash-command reference from a generic error hint so guidance reads correctly in the app.
