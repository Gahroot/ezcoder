---
"@kenkaiiii/gg-ai": patch
---

Fix GPT-6.1 Sol failing on ChatGPT (Codex) logins with "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." The ChatGPT backend only serves GPT-6.1 Sol to Codex clients 0.159.0 and newer, while GG Coder still identified itself as Codex 0.155.1. It now reports Codex 0.159.1, the latest release.
