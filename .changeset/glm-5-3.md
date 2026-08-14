---
"@kenkaiiii/gg-ai": minor
"@kenkaiiii/gg-core": minor
"@kenkaiiii/ggcoder": minor
---

**GLM-5.3 is now the only GLM model.** Z.AI's new coding-first flagship (released 2026-08-14) replaces GLM-5.2, and GLM-5.1 / GLM-4.7 / GLM-4.7 Flash are retired from the registry — they routed to strictly worse coding for the same plan quota, and the coding endpoint already answers `glm-5.2` requests as glm-5.3. Sessions saved on any retired id fall back to the provider default.

Same GLM-5 base as 5.2 with every gain from post-training: Z.AI reports ~50% better coding and open-source SOTA on Terminal-Bench 3.0 and Agent's Last Exam. Context window (1M) and max output (131K) are unchanged, so compaction budgeting is untouched.

**GLM thinking is now a real effort ladder, not an on/off toggle.** ggcoder previously sent only `thinking: { type: "enabled" }`, which silently ran Z.AI's `max` default at every setting. The endpoint in fact declares `none, minimal, low, medium, high, xhigh, max` (an unknown value 400s with that list), so `low / medium / high / xhigh / max` are now selectable and sent as `reasoning_effort` alongside the toggle. Measured end-to-end on one hard reasoning prompt: `low` → 0.8K reasoning chars in 15s, `high` → 3.2K in 28s, `max` → 24.9K in 129s. The default stays `max`, matching what the server was already doing, so existing behaviour is unchanged — but dialing effort *down* is now possible for the first time.

Note `max` is kept as `max` on the wire for GLM rather than remapped to `xhigh` the way OpenAI-compatible efforts are: GLM spells its own top rung `max`.

With no low-cost GLM sibling left, compaction-summary and scout sub-agent routing keep GLM-5.3 instead of downshifting — the existing graceful fallback, no crash and no cross-provider jump.
