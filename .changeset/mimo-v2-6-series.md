---
"@prestyj/ai": minor
"@prestyj/core": minor
"@prestyj/cli": minor
---

Upgrade Xiaomi to the MiMo-V2.6 series, replacing the V2.5 entries one-for-one:
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
